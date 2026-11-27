"""Coordinate model requests and run an isolated comparison shift."""

import asyncio
from copy import deepcopy
import time

import httpx

from backend.route_advisor import plan_routes
from backend import dispatch
from backend.llm import consult
from backend.harness import harness_for
from backend.simulation import WarehouseSimulation


async def planning_pass(sim, client: httpx.AsyncClient | None = None, *, request_limit: int | None = None, plan_motion: bool = True) -> bool:
    if not sim.running:
        return False
    use_model = sim.dispatch_mode in ("model", "demo")
    if request_limit is not None and sim.metrics["requests"] >= request_limit:
        client = None
    if not use_model:
        changed = sim.assign_orders()
    else:
        changed = False
        if any(robot.driver_phase == "idle" and not robot.stopped_by_operator for robot in sim.warehouse.robots):
            proposal = dispatch.assignments(sim)
            if proposal.options:
                batches = dispatch.compatible_batches(proposal)
                payload = {**proposal.payload(), "plans": batches, "tick": sim.tick_count,
                           "closed_cells": sorted(sim.zone_agent.blocked_cells)}
                warehouse, mode = sim.warehouse, sim.dispatch_mode
                try:
                    response = await consult(client, sim, "manager", payload) if client is not None or sim.dispatch_mode == "demo" else None
                except TimeoutError:
                    response = None
                if not sim.running or sim.dispatch_mode != mode or sim.warehouse is not warehouse:
                    harness_for(sim).resolve(response, "Отклонено: смена или режим изменились")
                    return False
                selected = batches.get(response[0][0], []) if response and len(response[0]) == 1 else []
                if response and selected and dispatch.apply_assignments(sim, proposal, selected, response[1]):
                    harness_for(sim).resolve(response, "Принято: назначения применены и товар зарезервирован")
                    selected_facts = [proposal.facts[key] for key in selected]
                    details = "; ".join(
                        f"{fact['order']} → {fact['robot']}, маршрут {fact['distance']} клеток, "
                        f"оценка {fact['route_score']}"
                        for fact in selected_facts
                    )
                    reason = f"{'Деморежим' if mode == 'demo' else 'ИИ'} выбрал {response[0][0]}. Данные расчёта: {details}."
                    dispatch.record(sim, proposal, selected, "demo" if mode == "demo" else "model",
                                    f"Предложены назначения {', '.join(selected)}. {reason}",
                                    batches=batches, selected_batch=response[0][0])
                    changed = True
                if not changed:
                    harness_for(sim).resolve(response, "Отклонено: предложение устарело или нарушает ограничения; применены правила")
                    sim.metrics["fallbacks"] += 1
                    reason = "Предложение не прошло проверку или устарело." if response else "Модель не вернула план."
                    dispatch.record(sim, proposal, [], "fallback", f"{reason} Назначения рассчитаны правилами.",
                                    batches=batches)
                    changed = sim.assign_orders()
                # A valid model plan may leave usable robots idle. Fill those
                # slots using the same stock, capacity and route checks.
                changed = sim.assign_orders() or changed
    if not plan_motion:
        return changed
    if request_limit is not None and sim.metrics["requests"] >= request_limit:
        client = None
    if sim.dispatch_mode == "model":
        zoned = await plan_zone(sim, client)
        return await plan_routes(sim, client, request_limit=request_limit) or zoned or changed
    return await plan_zone(sim, client if use_model else None) or changed


async def plan_zone(sim, client) -> bool:
    proposal = dispatch.zone_options(sim)
    if not proposal.options:
        return False
    warehouse, mode = sim.warehouse, sim.dispatch_mode
    ask = len(proposal.options) > 1 and (client is not None or mode == "demo")
    response = await consult(client, sim, "zone", proposal.payload(), deadline=2) if ask else None
    if not sim.running or sim.warehouse is not warehouse or sim.dispatch_mode != mode:
        harness_for(sim).resolve(response, "Отклонено: смена или режим изменились")
        return False
    if response and len(response[0]) == 1 and dispatch.apply_zone(sim, proposal, response[0][0]):
        selected, source = response[0][0], "demo" if mode == "demo" else "model"
        harness_for(sim).resolve(response, "Принято: план проезда передан симуляции")
        reason = "Выбран один из рассчитанных backend маршрутов."
    else:
        fallback = len(proposal.options) > 1 and mode in ("model", "demo")
        if ask:
            proposal = dispatch.zone_options(sim)
        if not proposal.options:
            harness_for(sim).resolve(response, "Отклонено: актуальных вариантов разъезда нет")
            return False
        selected = min(proposal.facts, key=lambda key:
                       proposal.facts[key].get("retreat_cells", 0) + proposal.facts[key]["passage_cells"])
        if not dispatch.apply_zone(sim, proposal, selected):
            harness_for(sim).resolve(response, "Отклонено: серверный план также недоступен")
            return False
        harness_for(sim).resolve(response, "Отклонено: применён актуальный серверный план")
        if fallback:
            sim.metrics["fallbacks"] += 1
        reason = "Выбран кратчайший из рассмотренных вариантов."
        source = "fallback" if fallback else "rules"
    option = proposal.facts[selected]
    if "yields" in option:
        action = f"{option['yields']} уступает у {option['wait_cell']}, {option['passes']} проезжает."
    else:
        action = f"{option['passes']}: выбран маршрут после перекрытия ({option['passage_cells']} клеток)."
    dispatch.record(sim, proposal, [selected], source, f"{action} {reason}")
    return True


async def compare_shift(client: httpx.AsyncClient | None, mode: str, harness=None, *, template=None) -> dict:
    sim = WarehouseSimulation()
    sim.agent_scope = "Сравнительный прогон"
    sim.dispatch_mode = mode
    if harness is not None:
        sim.harness = harness
    if template is None:
        sim.add_order("Дополнительный отбор A-14", (3, 1), (11, 6), "SKU-001", 2, priority=2, due_in_ticks=18)
    else:
        sim.shift_template = deepcopy(template)
        sim.custom_layout = sim.shift_template[0]
        sim.reset()
    # The isolated run returns metrics directly. No UI snapshot is needed per tick.
    sim.state = lambda: {}
    orders = {order.id: {"due_tick": order.due_tick, "delivery_tick": None}
              for order in sim.warehouse.orders if order.status == "pending"}
    sim.start(assign_orders=False)
    actions = {"offered": "accept", "confirm_pickup": "pickup", "confirm_delivery": "deliver"}
    closure = (5, 3)
    started = time.monotonic()
    for _ in range(1600):
        await planning_pass(sim, client, request_limit=6)
        if template is None and sim.tick_count == 2:
            sim.zone_agent.close_aisle(closure, set(sim.warehouse.obstacles), sim.warehouse.width, sim.warehouse.height)
            sim.coordination = None
            sim.closure_review = True
            sim._event(f"Демосценарий: перекрыта клетка {closure}.", "zone")
        if template is None and sim.tick_count == 12:
            sim.reopen_aisles()
        for robot in sim.warehouse.robots:
            if robot.order_id and robot.driver_phase in actions:
                order_id = robot.order_id
                action = actions[robot.driver_phase]
                sim.driver_action(robot.id, order_id, action)
                if action == "deliver" and order_id in orders:
                    orders[order_id]["delivery_tick"] = sim.tick_count
        if all(row["delivery_tick"] is not None for row in orders.values()):
            break
        sim.tick(assign_orders=False)
        # Yield to the live server even during a run with no model calls.
        if sim.tick_count % 20 == 0:
            await asyncio.sleep(0)
    history = harness_for(sim).history if mode != "rules" else ()
    accepted = sum(row["outcome"].startswith(("Принято:", "Маршрут проверен")) for row in history)
    return {**sim.shift_metrics(), "elapsed_ms": round((time.monotonic()-started)*1000), "source": mode,
            "deliveries": orders, "model_decisions": len(history), "accepted_decisions": accepted}
