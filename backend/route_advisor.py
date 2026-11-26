"""Ask the route agent for a connected sequence of directed aisle segments."""
import asyncio
from backend.harness import harness_for
from backend.llm import consult
from backend.traffic import permits


def occupied(sim, robot):
    return ({r.position for r in sim.warehouse.robots if r.id != robot.id} |
            {end for rid, (end, _) in sim.transit.items() if rid != robot.id})


def segments(sim, robot, goal):
    start = robot.position
    others = occupied(sim, robot)
    path = sim._plan_route(start, goal, others, heading=robot.heading)
    pieces = {}
    examples = []
    if not path:
        return pieces, examples
    alternatives = [path]
    if len(path) > 2:
        other = sim._plan_route(start, goal, others, {path[(len(path)-1)//2]}, heading=robot.heading)
        if other:
            alternatives.append(other)
    for route in alternatives:
        runs = []
        previous, direction = start, None
        for point in route:
            step = point[0] - previous[0], point[1] - previous[1]
            if step != direction:
                runs.append([previous])
            runs[-1].append(point)
            previous, direction = point, step
        ids = []
        for run in runs:
            a, b = run[0], run[-1]
            key = f"{a[0]},{a[1]}>{b[0]},{b[1]}"
            pieces[key] = run
            ids.append(key)
        examples.append(ids)
    return pieces, examples


async def plan_routes(sim, client):
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
        pieces, examples = segments(sim, robot, goal)
        if not pieces:
            continue
        data = {"robot": robot.id, "phase": key[1], "start": start, "goal": goal,
                "options": {k: len(v)-1 for k, v in pieces.items()}, "connected_sequences": examples}
        try:
            async with asyncio.timeout(2):
                answer = await consult(client, sim, "route", data)
        except TimeoutError:
            answer = None
        fallback = answer is None
        selected = examples[0] if fallback else answer[0]
        path = [start]
        blocked = occupied(sim, robot) | sim.zone_agent.blocked_cells
        for segment in selected:
            run = pieces.get(segment)
            if not run or run[0] != path[-1]:
                break
            path.extend(run[1:])
        else:
            if (sim.running and sim.dispatch_mode == "model" and sim.warehouse is layout
                    and not robot.stopped_by_operator and robot.position == start and sim.route_key(robot) == key
                    and path[-1] == goal and len(set(path)) == len(path) and not blocked.intersection(path[1:])
                    and all(permits(layout.lanes, a, b) and (sim.roads() is None or (a, b) in sim.roads() or (a, b) in sim.detour_edges)
                            for a, b in zip(path, path[1:]))):
                sim.model_routes[robot.id] = key, path
                robot.route = path[1:]
                robot.route_version += 1
                source = "Алгоритм (ИИ недоступен)" if fallback else "ИИ"
                reason = "Использован проверенный сервером маршрут." if fallback else answer[1]
                if fallback:
                    sim.metrics["fallbacks"] += 1
                sim._event(f"{source} передал маршрут {robot.id}: {len(path)-1} участков по {sim.NODE_SPACING_M:g} м. {reason}",
                           "robot", robot_id=robot.id)
                harness_for(sim).resolve(answer, "Маршрут проверен и передан погрузчику")
                changed = True
                continue
        harness_for(sim).resolve(answer, "Маршрут отклонён: нарушена связность или изменилась обстановка")
    return changed
