"""Approve ordinary routes locally and consult the model on routing tradeoffs."""

from backend.harness import harness_for
from backend.llm import consult
from backend.traffic import permits


def occupied(sim, robot):
    return ({r.position for r in sim.warehouse.robots if r.id != robot.id}
            | {end for rid, (end, _) in sim.transit.items() if rid != robot.id})


def route_facts(path):
    directions = [(b[0]-a[0], b[1]-a[1]) for a, b in zip(path, path[1:])]
    turns = sum(a != b for a, b in zip(directions, directions[1:]))
    return {"cells": len(directions), "turns": turns}


def route_rejection(sim, robot, key, path):
    if robot.stopped_by_operator:
        return "погрузчик остановлен"
    if robot.id in sim.transit or robot.position != path[0]:
        return "погрузчик сменил позицию"
    if sim.route_key(robot) != key:
        return "изменилась фаза или цель задания"
    if sim.coordination and any(step[0] == robot.id for step in sim.coordination):
        return "активирован план разъезда"
    blocked = occupied(sim, robot) | sim.zone_agent.blocked_cells
    first_blocked = next((cell for cell in path[1:] if cell in blocked), None)
    if first_blocked is not None:
        return f"клетка {first_blocked} занята или перекрыта"
    roads = sim.roads()
    for a, b in zip(path, path[1:]):
        if not permits(sim.warehouse.lanes, a, b) or (roads is not None and (a, b) not in roads):
            return f"проезд {a} → {b} недоступен"
    return None


async def plan_routes(sim, client, *, request_limit=None):
    layout = sim.warehouse
    changed = False
    for robot in sorted(layout.robots, key=lambda r: r.driver_phase == "offered"):
        if not sim.running or sim.dispatch_mode != "model" or sim.warehouse is not layout:
            break
        if sim.coordination and any(step[0] == robot.id for step in sim.coordination):
            continue
        if robot.stopped_by_operator or robot.id in sim.transit:
            continue
        key = sim.route_key(robot)
        start, goal = robot.position, key[-1]
        if goal is None or goal == start or sim.approved_route(robot) is not None:
            continue

        others = occupied(sim, robot)
        primary = sim._plan_route(start, goal, others, heading=robot.heading)
        if not primary:
            continue
        routes = {"route-1": [start, *primary]}
        if len(primary) > 2:
            other = sim._plan_route(start, goal, others, {primary[(len(primary)-1)//2]}, heading=robot.heading)
            if other:
                routes["route-2"] = [start, *other]
        facts = {name: route_facts(path) for name, path in routes.items()}
        best = min(facts, key=lambda name: (facts[name]["cells"], facts[name]["turns"]))
        tradeoff = any(fact["turns"] < facts[best]["turns"] for fact in facts.values())
        ask = tradeoff and client is not None and (request_limit is None or sim.metrics["requests"] < request_limit)
        answer = None
        if ask:
            data = {"robot": robot.id, "phase": key[1], "start": start, "goal": goal,
                    "carrying": robot.carrying_item, "options": facts}
            answer = await consult(client, sim, "route", data, deadline=2)
        if not sim.running or sim.dispatch_mode != "model" or sim.warehouse is not layout:
            harness_for(sim).resolve(answer, "Маршрут отклонён: смена или режим изменились")
            break

        selected = answer[0][0] if answer and len(answer[0]) == 1 else None
        path = routes.get(selected)
        rejection = route_rejection(sim, robot, key, path) if path else "неизвестный вариант"
        source = "ИИ"
        if rejection:
            harness_for(sim).resolve(answer, f"Маршрут отклонён: {rejection}")
            path = routes[best]
            if route_rejection(sim, robot, key, path):
                continue
            source = "Резервный алгоритм" if tradeoff else "Алгоритм"
            if tradeoff:
                sim.metrics["fallbacks"] += 1
        else:
            harness_for(sim).resolve(answer, "Маршрут проверен и передан погрузчику")

        sim.model_routes[robot.id] = key, path
        robot.route = path[1:]
        robot.route_version += 1
        metrics = route_facts(path)
        sim._event(f"{source} передал маршрут {robot.id}: {metrics['cells']} клеток, "
                   f"поворотов: {metrics['turns']}.", "robot", robot_id=robot.id)
        changed = True
    return changed
