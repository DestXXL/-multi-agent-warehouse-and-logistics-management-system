"""Coordinate model requests and run an isolated comparison shift."""

import httpx

from backend import dispatch
from backend.llm import consult
from backend.harness import harness_for
from backend.simulation import WarehouseSimulation


async def planning_pass(sim, client: httpx.AsyncClient | None = None, *, request_limit: int | None = None) -> bool:
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
                response = await consult(client, sim, "manager", payload) if client is not None or sim.dispatch_mode == "demo" else None
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
    if request_limit is not None and sim.metrics["requests"] >= request_limit:
        client = None
    return await plan_zone(sim, client if use_model else None) or changed


async def plan_zone(sim, client) -> bool:
    proposal = dispatch.zone_options(sim)
    if not proposal.options:
        return False
    warehouse, mode = sim.warehouse, sim.dispatch_mode
    response = await consult(client, sim, "zone", proposal.payload()) if client is not None or sim.dispatch_mode == "demo" else None
    if not sim.running or sim.warehouse is not warehouse or sim.dispatch_mode != mode:
        harness_for(sim).resolve(response, "Отклонено: смена или режим изменились")
        return False
    if response and len(response[0]) == 1 and dispatch.apply_zone(sim, proposal, response[0][0]):
        selected, source = response[0][0], "demo" if mode == "demo" else "model"
        harness_for(sim).resolve(response, "Принято: план проезда передан симуляции")
        reason = "Выбран один из рассчитанных backend маршрутов."
    else:
        harness_for(sim).resolve(response, "Отклонено: проезд недоступен; применены правила")
        if mode in ("model", "demo"):
            sim.metrics["fallbacks"] += 1
            proposal = dispatch.zone_options(sim)
        if not proposal.options:
            return False
        selected = min(proposal.facts, key=lambda key:
                       proposal.facts[key].get("retreat_cells", 0) + proposal.facts[key]["passage_cells"])
        if not dispatch.apply_zone(sim, proposal, selected):
            return False
        reason = "Выбран кратчайший из рассмотренных вариантов."
        source = "fallback" if mode in ("model", "demo") else "rules"
    option = proposal.facts[selected]
    if "yields" in option:
        action = f"{option['yields']} уступает у {option['wait_cell']}, {option['passes']} проезжает."
    else:
        action = f"{option['passes']}: выбран маршрут после перекрытия ({option['passage_cells']} клеток)."
    dispatch.record(sim, proposal, [selected], source, f"{action} {reason}")
    return True


async def compare_shift(client: httpx.AsyncClient | None, mode: str, harness=None) -> dict:
    sim = WarehouseSimulation()
    sim.agent_scope = "Сравнительная демосмена"
    sim.dispatch_mode = mode
    if harness is not None:
        sim.harness = harness
    sim.add_order("Дополнительный отбор A-14", (3, 1), (11, 6), "SKU-001", 2, priority=2, due_in_ticks=18)
    sim.start(assign_orders=False)
    actions = {"offered": "accept", "confirm_pickup": "pickup", "confirm_delivery": "deliver"}
    closure = (5, 3)
    import time
    started = time.monotonic()
    for _ in range(80):
        await planning_pass(sim, client, request_limit=6)
        if sim.tick_count == 2:
            sim.zone_agent.close_aisle(closure, set(sim.warehouse.obstacles), sim.warehouse.width, sim.warehouse.height)
            sim.coordination = None
            sim.closure_review = True
            sim._event(f"Демосценарий: перекрыта клетка {closure}.", "zone")
        if sim.tick_count == 12:
            sim.reopen_aisles()
        for robot in sim.warehouse.robots:
            if robot.order_id and robot.driver_phase in actions:
                sim.driver_action(robot.id, robot.order_id, actions[robot.driver_phase])
        sim.tick(assign_orders=False)
        if sim.tick_count >= 13 and all(order.status == "completed" for order in sim.warehouse.orders):
            break
    return {**sim.shift_metrics(), "elapsed_ms": round((time.monotonic()-started)*1000), "source": mode}
