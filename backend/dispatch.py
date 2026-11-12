"""Build bounded dispatch options and validate choices before changing the warehouse."""

from collections import Counter
from itertools import islice
from dataclasses import dataclass
from typing import TYPE_CHECKING

from backend.models import Point, Robot

if TYPE_CHECKING:
    from backend.simulation import WarehouseSimulation


@dataclass
class Proposal:
    role: str
    revision: int
    options: dict
    facts: dict

    def payload(self) -> dict:
        return {"revision": self.revision, "options": self.facts}


def assignments(sim: "WarehouseSimulation") -> Proposal:
    choices, facts = {}, {}
    orders = sorted(
        sim._pending_orders(),
        key=lambda order: (
            order.due_tick is None, order.due_tick or 0, -order.priority, order.created_tick, order.id,
        ),
    )
    for order in orders[:8]:
        base = sim._assignment_options(order)
        if not base:
            continue
        candidates = list(base[:6])
        seen = {(robot.id, tuple(a.stock_item_id for a in rows)) for robot, _, rows in candidates}
        stock_sources = (
            row for row in sim.warehouse.inventory
            if row.product_id == order.product_id and row.quantity > sum(row.reservations.values())
        )
        for stock in islice(stock_sources, 8):
            if len(candidates) >= 9:
                break
            for candidate in sim._assignment_options(order, stock.id):
                robot, _, rows = candidate
                identity = robot.id, tuple(a.stock_item_id for a in rows)
                if identity not in seen:
                    seen.add(identity)
                    candidates.append(candidate)
                if len(candidates) >= 9:
                    break
        for index, (robot, score, rows) in enumerate(candidates):
            key = f"{order.id}/{index + 1}"
            choices[key] = (order, (robot, score, rows))
            facts[key] = {
                "order": order.id, "priority": order.priority,
                "due_tick": order.due_tick, "created_tick": order.created_tick,
                "robot": robot.id, "position": robot.position,
                "route_score": score,
                "free_capacity": robot.basket_capacity - robot.basket_load,
                "distance": route_distance(sim, robot, order.dropoff, rows),
                "pickups": {a.storage_location_id: a.quantity for a in rows},
                "stock_available": {
                    a.stock_item_id: len(sim._free_placements(sim._get_stock_item(a.stock_item_id)))
                    for a in rows
                },
                "stock_required": {a.stock_item_id: a.quantity for a in rows},
            }
    return Proposal("manager", sim.revision, choices, facts)


def compatible_batches(proposal: Proposal) -> dict[str, list[str]]:
    """Keep a small beam of feasible combinations across the ordered queue."""
    groups: dict[str, list[str]] = {}
    for key, facts in proposal.facts.items():
        groups.setdefault(facts["order"], []).append(key)
    beam: list[tuple[list[str], set[str], Counter, int, int]] = [([], set(), Counter(), 0, 0)]
    for rank, options in enumerate(groups.values()):
        expanded = list(beam)
        for selected, used, reserved, priority, distance in beam:
            for key in options:
                option = proposal.facts[key]
                if option["robot"] in used:
                    continue
                remaining = reserved + Counter(option["stock_required"])
                if any(remaining[sku] > count for sku, count in option["stock_available"].items()):
                    continue
                expanded.append((
                    [*selected, key], used | {option["robot"]}, remaining,
                    priority + len(groups) - rank, distance + option["distance"],
                ))
        beam = sorted(expanded, key=lambda row: (-len(row[0]), -row[3], row[4], row[0]))[:24]
    return {f"plan-{index}": row[0] for index, row in enumerate(beam[:8], 1) if row[0]}


def route_distance(sim, robot, dropoff, allocations) -> int:
    occupied = {other.position for other in sim.warehouse.robots if other.id != robot.id}
    stops = [robot.position, *(sim._get_stock_item(a.stock_item_id).position for a in allocations), dropoff]
    return sum(sim._route_cost(start, goal, occupied) or 0 for start, goal in zip(stops, stops[1:]))


def apply_assignments(sim, original: Proposal, selected: list[str], reason: str) -> bool:
    current = assignments(sim)
    if original.revision != current.revision or original.facts != current.facts:
        return False
    if not selected or not set(selected) <= current.options.keys():
        return False
    orders, robots, stock = set(), set(), Counter()
    for key in selected:
        order, (robot, _, rows) = current.options[key]
        if order.id in orders or robot.id in robots:
            return False
        orders.add(order.id)
        robots.add(robot.id)
        stock.update({a.stock_item_id: a.quantity for a in rows})
    if any(count > len(sim._free_placements(sim._get_stock_item(key))) for key, count in stock.items()):
        return False
    for key in selected:
        order, option = current.options[key]
        sim.apply_assignment(order, option, reason)
    return True


def storage_options(sim, dimensions, quantity, dropoff: Point) -> Proposal:
    locations = sim.warehouse.storage_locations
    racks = {rack.id: rack for rack in sim.warehouse.racks}
    load = Counter()
    for item in sim.warehouse.inventory:
        if item.location_id:
            load[item.location_id] += item.quantity
    demand = Counter()
    for order in sim.warehouse.orders:
        for allocation in order.allocations:
            if allocation.picked:
                demand[allocation.storage_location_id] += allocation.quantity
    distances = {
        key: sim._route_cost(rack.position, dropoff, set())
        for key, rack in racks.items()
    }
    reachable = [location for location in locations if distances[location.rack_id] is not None]
    choices, facts = {}, {}
    sequences = [
        reachable,
        sorted(reachable, key=lambda loc: (distances[loc.rack_id], loc.id)),
        sorted(reachable, key=lambda loc: (load[loc.id], distances[loc.rack_id], loc.id)),
        sorted(reachable, key=lambda loc: (demand[loc.id], load[loc.id], loc.id)),
    ]
    for sequence in sequences:
        plan = sim.manager_agent.choose_storage_positions(dimensions, quantity, sequence, sim.warehouse.inventory)
        if plan is None or plan in choices.values():
            continue
        key = f"storage-{len(choices) + 1}"
        choices[key] = plan
        facts[key] = [
            {"address": loc.id, "quantity": len(rows), "packages_already_stored": load[loc.id],
             "previously_picked_packages": demand[loc.id], "distance_to_shipping_cells": distances[loc.rack_id]}
            for loc, rows in plan
        ]
    return Proposal("storage", sim.revision, choices, facts)


def destination(sim, robot: Robot) -> Point | None:
    if robot.driver_phase == "returning":
        return robot.home
    if robot.order_id and robot.driver_phase in ("to_pickup", "to_dropoff"):
        order = sim._get_order(robot.order_id)
        return order.dropoff if robot.driver_phase == "to_dropoff" else sim._current_pickup_point(order)
    return None


def zone_options(sim) -> Proposal:
    choices, facts = {}, {}
    if sim.coordination:
        return Proposal("zone", sim.revision, choices, facts)
    mobile = [robot for robot in sim.warehouse.robots
              if not robot.stopped_by_operator and destination(sim, robot) not in (None, robot.position)]
    for passing in mobile:
        if sim.motion_wait.get(passing.id, 0) < 3:
            continue
        target = destination(sim, passing)
        for yielding in mobile:
            if yielding is passing:
                continue
            fixed = {r.position for r in sim.warehouse.robots if r.id not in (passing.id, yielding.id)}
            if sim._plan_route(passing.position, target, fixed | {yielding.position}) is not None:
                continue
            if sim._plan_route(passing.position, target, fixed) is None:
                continue
            yield_goal = destination(sim, yielding)
            x, y = yielding.position
            nearby = sorted(
                ((a, b) for a in range(x - 3, x + 4) for b in range(y - 3, y + 4)
                 if 0 < abs(a-x) + abs(b-y) <= 3),
                key=lambda point: (abs(point[0]-x) + abs(point[1]-y), point),
            )
            for side in nearby:
                if side in (target, yield_goal):
                    continue
                retreat = sim._plan_route(yielding.position, side, fixed | {passing.position}, {yield_goal})
                if not retreat or len(retreat) > 5:
                    continue
                passage = sim._plan_route(passing.position, target, fixed | {side})
                if not passage or len(passage) > 16:
                    continue
                if sim._plan_route(side, yield_goal, fixed | {target}) is None:
                    continue
                key = f"yield-{len(choices)+1}"
                choices[key] = [(yielding.id, yield_goal, retreat, True), (passing.id, target, passage, True)]
                facts[key] = {
                    "yields": yielding.id, "wait_cell": side, "passes": passing.id,
                    "retreat_cells": len(retreat), "passage_cells": len(passage),
                    "passing_with_cargo": passing.carrying_item, "yielding_with_cargo": yielding.carrying_item,
                }
                if len(choices) == 6:
                    return Proposal("zone", sim.revision, choices, facts)
    if not choices and sim.closure_review:
        for robot in mobile:
            target = destination(sim, robot)
            occupied = {other.position for other in sim.warehouse.robots if other.id != robot.id}
            shortest = sim._plan_route(robot.position, target, occupied)
            if not shortest:
                continue
            routes = [shortest]
            for cell in shortest[:5]:
                alternative = sim._plan_route(robot.position, target, occupied, {cell})
                if alternative and alternative not in routes:
                    routes.append(alternative)
                if len(routes) == 3:
                    break
            for route in routes:
                key = f"bypass-{len(choices)+1}"
                choices[key] = [(robot.id, target, route, False)]
                facts[key] = {
                    "passes": robot.id, "passage_cells": len(route), "position": robot.position,
                    "route_start": route[:4], "closed_cells": sorted(sim.zone_agent.blocked_cells),
                    "passing_with_cargo": robot.carrying_item,
                }
            if len(choices) >= 6:
                break
    return Proposal("zone", sim.revision, choices, facts)


def apply_zone(sim, original: Proposal, choice: str) -> bool:
    if original.revision != sim.revision or choice not in original.options or sim.coordination:
        return False
    plan = original.options[choice]
    if plan[0][3]:
        current = zone_options(sim)
        if original.options != current.options:
            return False
    else:
        robot_id, goal, route, _ = plan[0]
        robot = sim._get_robot(robot_id)
        if robot.stopped_by_operator or destination(sim, robot) != goal:
            return False
        # The ordinary tick can advance while the model is choosing a bypass.
        if robot.position != original.facts[choice]["position"]:
            if robot.position not in route:
                return False
            route = route[route.index(robot.position) + 1:]
        blocked = set(sim.warehouse.obstacles) | sim.zone_agent.blocked_cells
        blocked.update(other.position for other in sim.warehouse.robots if other.id != robot_id)
        if not route or blocked.intersection(route):
            return False
        plan = [(robot_id, goal, route, False)]
    sim.coordination = plan
    sim.closure_review = False
    for robot_id, _, route, _ in sim.coordination:
        sim._get_robot(robot_id).route = route
        sim._get_robot(robot_id).route_version += 1
    return True


def coordination_step(sim):
    if not sim.coordination:
        return None
    if any(sim._get_robot(key).stopped_by_operator or destination(sim, sim._get_robot(key)) != goal
           for key, goal, _, _ in sim.coordination):
        sim.coordination = None
        sim._event("План разъезда отменён: состояние техники изменилось.", "zone")
        return None
    robot_id, goal, route, exclusive = sim.coordination[0]
    robot = sim._get_robot(robot_id)
    blocked = set(sim.warehouse.obstacles) | sim.zone_agent.blocked_cells
    blocked.update(other.position for other in sim.warehouse.robots if other.id != robot_id)
    if route[0] in blocked or sum(abs(a-b) for a, b in zip(robot.position, route[0])) != 1:
        sim.coordination = None
        sim._event("План разъезда отменён: следующая клетка недоступна.", "zone")
        return None
    return robot_id, route


def record(sim, proposal: Proposal, choice: list[str], source: str, reason: str, **details) -> None:
    sim.decisions.appendleft({
        "role": proposal.role, "revision": proposal.revision, "source": source,
        "selected": choice, "options": proposal.facts, "reason": reason, "tick": sim.tick_count,
        **details,
    })
    sim._event(reason, "zone" if proposal.role == "zone" else "manager")


def operator_facts(sim, target: str | None, closure: Point | None) -> list[str]:
    warehouse = sim.warehouse
    facts = [f"Склад: {'работает' if sim.running else 'на паузе'}, такт {sim.tick_count}, режим {sim.dispatch_mode}."]
    for order in warehouse.orders:
        if order.status in ("pending", "cancelled") or target and order.id != target:
            continue
        facts.append(f"{order.id}: статус {order.status}, приоритет {order.priority}, исполнитель {order.robot_id or 'не назначен'}, количество {order.quantity}.")
        if len(facts) >= 9:
            break
    pending_count = 0
    for order in sim._pending_orders():
        if target and order.id != target:
            continue
        matching = [item for item in warehouse.inventory
                    if (item.product_id or item.id) == (order.product_id or order.item_id)]
        available = sum(len(sim._free_placements(item)) for item in matching)
        idle = [r for r in warehouse.robots if not r.stopped_by_operator and r.driver_phase == "idle" and not r.order_id]
        if available < order.quantity:
            reason = f"свободно {available} из {order.quantity} шт."
        elif not idle:
            reason = "нет свободных погрузчиков"
        elif matching and not any(r.basket_capacity - r.basket_load >= sim.manager_agent.ITEM_LOAD[matching[0].size] for r in idle):
            reason = "свободным погрузчикам не хватает вместимости"
        elif not sim._assignment_options(order):
            reason = "для свободной техники нет полного доступного маршрута отбора и доставки"
        elif not sim.running:
            reason = "есть допустимое назначение, симуляция приостановлена" if sim.tick_count else "есть допустимое назначение, симуляция ещё не запущена"
        else:
            reason = "есть допустимое назначение, заказ ожидает планирования"
        facts.append(f"{order.id}: {reason}; приоритет {order.priority}, срок в тактах {order.due_tick if order.due_tick is not None else 'не задан'}.")
        pending_count += 1
        if pending_count == 8:
            break
    for robot in warehouse.robots:
        if target and robot.id != target:
            continue
        if robot.stopped_by_operator:
            detail = "остановлен оператором"
        elif robot.driver_phase in ("offered", "confirm_pickup", "confirm_delivery"):
            detail = "ожидает подтверждения водителя"
        elif sim.motion_wait.get(robot.id, 0) and robot.status == "waiting":
            detail = f"ожидает доступного пути {sim.motion_wait[robot.id]} тактов"
        else:
            detail = f"координаты {robot.position}, осталось клеток маршрута: {len(robot.route)}"
        facts.append(f"{robot.id}: {detail}; задание {robot.order_id or 'отсутствует'}, фаза {robot.driver_phase}, загрузка {robot.basket_load}/{robot.basket_capacity}.")
    if closure is not None:
        for robot in warehouse.robots:
            if closure not in robot.route:
                continue
            goal = robot.route[-1]
            occupied = {other.position for other in warehouse.robots if other.id != robot.id}
            alternative = sim._plan_route(robot.position, goal, occupied, {closure})
            effect = f"обход на {len(alternative)} клеток" if alternative else "нет доступного обхода"
            facts.append(f"Перекрытие {closure} затронет {robot.order_id or robot.id}: {effect}.")
        if not any(line.startswith("Перекрытие") for line in facts):
            facts.append(f"Клетка {closure} отсутствует на текущих маршрутах.")
    if target and len(facts) == 1:
        order = next((order for order in warehouse.orders if order.id == target), None)
        facts.append(f"{target}: статус {order.status}." if order else f"{target}: заказ или техника не найдены.")
    return facts
