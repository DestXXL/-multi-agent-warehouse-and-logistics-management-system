"""Deterministic agent roles used before an LLM provider is connected."""

from collections import deque

from backend.models import Order, Point, Robot, StockItem


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
