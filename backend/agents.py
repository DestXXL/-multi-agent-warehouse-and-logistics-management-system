"""Deterministic agent roles used before an LLM provider is connected."""

from collections import deque
from typing import Callable

from backend.models import Order, Point, Robot, StockItem, StockAllocation, StorageLocation
from backend.rack_types import pack_packages


class ManagerAgent:
    """Select an available robot using order priority, distance, and item size."""

    ITEM_LOAD = {"small": 1, "medium": 2, "large": 3}

    def choose_robot(
        self,
        order: Order,
        item: StockItem,
        robots: list[Robot],
    ) -> tuple[Robot, int] | None:
        load = self.ITEM_LOAD[item.size]
        available = [
            robot for robot in robots
            if robot.order_id is None
            and robot.driver_phase == "idle"
            and not robot.stopped_by_operator
            and robot.basket_capacity - robot.basket_load >= load
        ]
        if not available:
            return None
        robot = min(
            available,
            key=lambda robot: (
                -self.assignment_score(order, item, robot),
                robot.id,
            ),
        )
        return robot, self.assignment_score(order, item, robot)

    def assignment_score(self, order: Order, item: StockItem, robot: Robot) -> int:
        distance = abs(robot.position[0] - item.position[0]) + abs(robot.position[1] - item.position[1])
        size_load = self.ITEM_LOAD[item.size]
        return order.priority * 10 - distance * 2 - size_load

    def choose_storage_positions(
        self,
        dimensions: tuple[int, int, int],
        quantity: int,
        locations: list[StorageLocation],
        stock_items: list[StockItem],
    ) -> list[tuple[StorageLocation, list[dict]]] | None:
        """Plan a deterministic, non-overlapping surface for each new box."""
        remaining = quantity
        plan: list[tuple[StorageLocation, list[dict]]] = []
        for location in locations:
            if not location.enabled:
                continue
            occupied = [
                rectangle
                for stock in stock_items
                if stock.location_id == location.id and stock.quantity > 0
                for rectangle in stock.unit_placements
            ]
            placements = pack_packages(dimensions, remaining, location, occupied)
            if placements:
                plan.append((location, placements))
                remaining -= len(placements)
            if remaining == 0:
                return plan
        return None

    def choose_storage_assignment(
        self,
        order: Order,
        stock_items: list[StockItem],
        robots: list[Robot],
        route_cost: Callable[[Point, Point, set[Point]], int | None],
    ) -> tuple[Robot, int, list[StockAllocation]] | None:
        """Choose a reachable robot and the lowest-cost stock locations covering an order."""
        candidates = [item for item in stock_items if (item.product_id or item.id) == order.product_id and item.location_id]
        if not candidates:
            return None
        best: tuple[Robot, int, list[StockAllocation]] | None = None
        occupied_by_robot = {
            robot.id: {other.position for other in robots if other.id != robot.id}
            for robot in robots
        }
        for robot in robots:
            if robot.order_id is not None or robot.driver_phase != "idle" or robot.stopped_by_operator:
                continue
            available_items = [item for item in candidates if item.quantity - sum(item.reservations.values()) > 0]
            item_size = available_items[0].size if available_items else candidates[0].size
            load = self.ITEM_LOAD[item_size]
            if robot.basket_capacity - robot.basket_load < load:
                continue
            remaining = order.quantity
            current = robot.position
            total_cost = 0
            allocations: list[StockAllocation] = []
            remaining_items = list(available_items)
            while remaining and remaining_items:
                ranked: list[tuple[int, str, StockItem]] = []
                for item in remaining_items:
                    first_leg = route_cost(current, item.position, occupied_by_robot[robot.id])
                    if first_leg is None:
                        continue
                    tail = route_cost(item.position, order.dropoff, occupied_by_robot[robot.id])
                    if tail is not None:
                        ranked.append((first_leg + tail, item.id, item))
                if not ranked:
                    break
                _, _, item = min(ranked)
                amount = min(remaining, item.quantity - sum(item.reservations.values()))
                if amount <= 0:
                    remaining_items.remove(item)
                    continue
                leg = route_cost(current, item.position, occupied_by_robot[robot.id])
                assert leg is not None
                total_cost += leg
                allocations.append(StockAllocation(item.id, item.location_id, amount))
                current = item.position
                remaining -= amount
                remaining_items.remove(item)
            if remaining:
                continue
            last_leg = route_cost(current, order.dropoff, occupied_by_robot[robot.id])
            if last_leg is None:
                continue
            total_cost += last_leg
            score = order.priority * 10 - total_cost * 2 - load
            if best is None or score > best[1] or (score == best[1] and robot.id < best[0].id):
                best = (robot, score, allocations)
        return best


class RobotAgent:
    """Find a shortest valid path using breadth-first search."""

    DIRECTIONS = [(1, 0), (0, 1), (-1, 0), (0, -1)]

    def plan_route(
        self,
        start: Point,
        goal: Point,
        width: int,
        height: int,
        blocked: set[Point],
        occupied: set[Point],
    ) -> list[Point] | None:
        queue = deque([(start, [])])
        visited = {start}
        while queue:
            point, route = queue.popleft()
            if point == goal:
                return route
            for dx, dy in self.DIRECTIONS:
                neighbor = (point[0] + dx, point[1] + dy)
                if (
                    neighbor in visited
                    or not (0 <= neighbor[0] < width and 0 <= neighbor[1] < height)
                    or neighbor in blocked
                    or neighbor in occupied
                ):
                    continue
                visited.add(neighbor)
                queue.append((neighbor, route + [neighbor]))
        return None


class ZoneAgent:
    """Track temporary aisle closures and reject invalid closure points."""

    def __init__(self) -> None:
        self.blocked_cells: set[Point] = set()

    def clear(self) -> None:
        self.blocked_cells.clear()

    def close_aisle(self, point: Point, obstacles: set[Point], width: int, height: int) -> None:
        if not (0 <= point[0] < width and 0 <= point[1] < height):
            raise ValueError("Клетка находится вне карты")
        if point in obstacles:
            raise ValueError("Нельзя перекрыть стеллаж")
        self.blocked_cells.add(point)
