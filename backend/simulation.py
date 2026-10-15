"""Warehouse simulation coordinated by deterministic software agents."""

from collections import deque
from datetime import UTC, datetime

from backend.agents import ManagerAgent, RobotAgent, ZoneAgent
from backend.models import Order, Point, Robot, StockItem, Warehouse


class WarehouseSimulation:
    TICK_SECONDS = 1.0

    def __init__(self) -> None:
        self.manager_agent = ManagerAgent()
        self.robot_agent = RobotAgent()
        self.zone_agent = ZoneAgent()
        self.custom_layout = None
        self.reset()

    def reset(self) -> None:
        obstacles = [(x, y) for x in range(4, 8) for y in (1, 2, 4, 5)]
        self.warehouse = Warehouse(
            width=12,
            height=8,
            obstacles=obstacles,
            pickup_points=[(3, 1), (3, 6), (8, 1), (8, 6)],
            shipping_points=[(11, 1), (11, 6)],
            robots=[Robot(id="R-01", position=(0, 1), home=(0, 1)), Robot(id="R-02", position=(0, 6), home=(0, 6))],
            orders=[
                Order(id="ORD-001", item="Коробка A-14", pickup=(3, 1), dropoff=(11, 1), item_id="SKU-001", priority=3),
                Order(id="ORD-002", item="Коробка B-07", pickup=(3, 6), dropoff=(11, 6), item_id="SKU-002", priority=2),
                Order(id="ORD-003", item="Коробка C-22", pickup=(8, 1), dropoff=(11, 6), item_id="SKU-003", priority=1),
            ],
            inventory=[
                StockItem(id="SKU-001", name="Коробка A-14", position=(3, 1), size="small"),
                StockItem(id="SKU-002", name="Коробка B-07", position=(3, 6), size="medium"),
                StockItem(id="SKU-003", name="Коробка C-22", position=(8, 1), size="large"),
            ],
        )
        if self.custom_layout is not None:
            self.warehouse = self.custom_layout.warehouse()
        self.running = False
        self.zone_agent.clear()
        self.tick_count = 0
        self.next_order_number = 4
        self.events: deque[dict] = deque(maxlen=100)
        self._event("Склад подготовлен. Ожидается запуск симуляции.", "system")

    def state(self) -> dict:
        warehouse = self.warehouse.to_dict()
        for data, robot in zip(warehouse["robots"], self.warehouse.robots):
            data["can_report_obstacle"] = self._report_point(robot) is not None
        warehouse["closed_cells"] = [list(point) for point in sorted(self.zone_agent.blocked_cells)]
        return {
            "running": self.running,
            "tick": self.tick_count,
            "can_create_congestion": self._congestion_candidate() is not None,
            "warehouse": warehouse,
            "events": list(self.events),
        }

    def start(self) -> dict:
        if not self.running:
            self.running = True
            self._event("Симуляция запущена. Откройте планшет и примите задание.", "system")
            self._assign_orders()
        return self.state()

    def pause(self) -> dict:
        if self.running:
            self.running = False
            self._event("Симуляция приостановлена оператором.", "operator")
        return self.state()

    def add_order(self, item: str, pickup: Point, dropoff: Point) -> dict:
        order_id = f"ORD-{self.next_order_number:03d}"
        item_id = f"SKU-{self.next_order_number:03d}"
        order = Order(
            id=order_id,
            item=item,
            pickup=pickup,
            dropoff=dropoff,
            item_id=item_id,
        )
        self.warehouse.inventory.append(
            StockItem(id=item_id, name=item, position=pickup, size="medium")
        )
        self.next_order_number += 1
        self.warehouse.orders.append(order)
        self._event(f"Создан заказ {order.id}: {item}.", "operator", order_id=order.id)
        return self.state()

    def stop_robot(self, robot_id: str) -> dict:
        robot = self._get_robot(robot_id)
        robot.stopped_by_operator = True
        robot.status = "stopped"
        self._event(f"Оператор остановил погрузчик {robot_id}.", "operator", robot_id=robot_id)
        return self.state()

    def resume_robot(self, robot_id: str) -> dict:
        robot = self._get_robot(robot_id)
        robot.stopped_by_operator = False
        self._refresh_route(robot)
        self._event(f"Оператор продолжил работу погрузчик {robot_id}.", "operator", robot_id=robot_id)
        return self.state()

    def _report_point(self, robot: Robot) -> Point | None:
        if not robot.order_id or not robot.route:
            return None
        order = self._get_order(robot.order_id)
        occupied = {item.position for item in self.warehouse.robots}
        # A report closes the next aisle cell, never a vehicle or a handling location.
        point = robot.route[0]
        if point in occupied or point in (order.pickup, order.dropoff):
            return None
        return point

    def create_congestion(self, robot_id: str | None = None) -> dict:
        if robot_id:
            robot = self._get_robot(robot_id)
            point = self._report_point(robot)
            if point is None:
                raise ValueError("Впереди нет прохода, который можно перекрыть")
        else:
            selected = self._congestion_candidate()
            if selected is None:
                raise ValueError("Нет подходящего прохода для демонстрации затора")
            robot, point, _ = selected
        self.zone_agent.close_aisle(point, set(self.warehouse.obstacles), self.warehouse.width, self.warehouse.height)
        self._event(f"Проход {point} закрыт по сообщению водителя {robot.id}.", "zone", robot_id=robot.id)
        for resource in self.warehouse.robots:
            if point in resource.route or resource.id == robot.id:
                self._refresh_route(resource)
                resource.route_version += 1
                result = f"обход: {len(resource.route)} клеток" if resource.route else "ожидание свободного пути"
                self._event(f"{resource.id}: {result}.", "manager", robot_id=resource.id)
        return self.state()

    def reopen_aisles(self) -> dict:
        self.zone_agent.clear()
        for robot in self.warehouse.robots:
            self._refresh_route(robot)
            robot.route_version += 1
        self._event("Диспетчер открыл перекрытые проходы. Маршруты обновлены.", "operator")
        return self.state()

    def _refresh_route(self, robot: Robot) -> None:
        if robot.driver_phase == "returning":
            occupied = {other.position for other in self.warehouse.robots if other.id != robot.id}
            robot.route = self._plan_route(robot.position, robot.home, occupied) or []
            robot.status = "stopped" if robot.stopped_by_operator else "moving" if robot.route else "waiting"
            return
        if not robot.order_id:
            robot.route = []
            robot.status = "stopped" if robot.stopped_by_operator else "idle"
            return
        order = self._get_order(robot.order_id)
        destination = order.dropoff if robot.carrying_item else order.pickup
        occupied = {other.position for other in self.warehouse.robots if other.id != robot.id}
        robot.route = self._plan_route(robot.position, destination, occupied) or []
        if robot.stopped_by_operator:
            robot.status = "stopped"
        elif robot.driver_phase in ("offered", "confirm_pickup", "confirm_delivery"):
            robot.status = "waiting"
        else:
            robot.status = "moving" if robot.route else "waiting"

    def driver_action(self, robot_id: str, order_id: str, action: str) -> dict:
        robot = self._get_robot(robot_id)
        if robot.order_id != order_id:
            raise ValueError("Задание изменилось. Обновите экран перед подтверждением")
        order = self._get_order(order_id)
        stock = self._get_stock_item(order.item_id)
        if robot.stopped_by_operator:
            raise ValueError("Сначала возобновите работу погрузчика")
        if action == "accept" and robot.driver_phase == "offered":
            robot.driver_phase = "to_pickup"
            message = "принял задание"
        elif action == "pickup" and robot.driver_phase == "confirm_pickup" and robot.position == order.pickup:
            if stock.reserved_by != order.id or stock.status != "reserved":
                raise ValueError("Резерв товара не соответствует заданию")
            robot.carrying_item = True
            robot.basket_load = self.manager_agent.ITEM_LOAD[stock.size]
            stock.status = "picked"
            robot.driver_phase = "to_dropoff"
            order.status = "delivering"
            message = "подтвердил забор товара"
        elif action == "deliver" and robot.driver_phase == "confirm_delivery" and robot.position == order.dropoff:
            stock.status = "delivered"
            stock.position = order.dropoff
            stock.reserved_by = None
            robot.carrying_item = False
            robot.basket_load = 0
            robot.order_id = None
            robot.driver_phase = "returning"
            order.status = "completed"
            message = "подтвердил доставку товара"
        else:
            raise ValueError("Действие недоступно на текущем этапе задания")
        self._refresh_route(robot)
        self._event(f"Водитель {robot.id} {message}: {order.id}.", "driver", robot_id=robot.id, order_id=order.id)
        return self.state()

    def _congestion_candidate(self) -> tuple[Robot, Point, list[Point]] | None:
        candidates = [robot for robot in self.warehouse.robots if len(robot.route) >= 3 and not robot.stopped_by_operator]
        selected: tuple[Robot, Point, list[Point]] | None = None
        for robot in candidates:
            if not robot.order_id:
                continue
            order = self._get_order(robot.order_id)
            goal = order.dropoff if robot.carrying_item else order.pickup
            occupied = {item.position for item in self.warehouse.robots if item.id != robot.id}
            existing_route = self._plan_route(robot.position, goal, occupied)
            if not existing_route:
                continue
            for point in existing_route[1:-1]:
                alternative = self._plan_route(robot.position, goal, occupied, {point})
                if alternative and len(alternative) > len(existing_route):
                    selected = (robot, point, alternative)
                    break
            if selected:
                break
        return selected

    def tick(self) -> dict:
        if not self.running:
            return self.state()

        self.tick_count += 1
        self._assign_orders()
        occupied = {robot.position for robot in self.warehouse.robots}

        for robot in sorted(self.warehouse.robots, key=lambda item: item.id):
            if robot.stopped_by_operator:
                continue
            if robot.driver_phase == "returning":
                occupied.discard(robot.position)
                route = self._plan_route(robot.position, robot.home, occupied)
                if route:
                    robot.position = route[0]
                    robot.route = route[1:]
                    robot.status = "moving"
                else:
                    robot.route = []
                    robot.status = "waiting"
                occupied.add(robot.position)
                if robot.position == robot.home:
                    robot.driver_phase = "idle"
                    robot.status = "idle"
                continue
            if not robot.order_id:
                continue
            if robot.driver_phase not in ("to_pickup", "to_dropoff"):
                continue
            order = self._get_order(robot.order_id)
            destination = order.dropoff if robot.carrying_item else order.pickup
            if robot.position != destination:
                occupied.discard(robot.position)
                route = self._plan_route(robot.position, destination, occupied)
                if route:
                    robot.position = route[0]
                    robot.route = route[1:]
                    robot.status = "moving"
                    if robot.carrying_item:
                        self._get_stock_item(order.item_id).position = robot.position
                else:
                    robot.route = []
                    robot.status = "waiting"
                occupied.add(robot.position)
            if robot.position == destination:
                robot.driver_phase = "confirm_delivery" if robot.carrying_item else "confirm_pickup"
                robot.status = "waiting"
                robot.route = []
                if not robot.carrying_item:
                    order.status = "picking"
                self._event(f"{robot.id} прибыл в {destination}. Требуется подтверждение водителя.", "system", robot_id=robot.id, order_id=order.id)

        return self.state()

    def _assign_orders(self) -> None:
        pending_orders = sorted(
            (order for order in self.warehouse.orders if order.status == "pending"),
            key=lambda order: (-order.priority, order.id),
        )
        for order in pending_orders:
            stock_item = self._get_stock_item(order.item_id)
            if stock_item.status != "available":
                continue
            assignment = self.manager_agent.choose_robot(order, stock_item, self.warehouse.robots)
            if assignment is None:
                continue
            robot, score = assignment
            robot.order_id = order.id
            robot.driver_phase = "offered"
            robot.status = "waiting"
            order.robot_id = robot.id
            order.status = "assigned"
            stock_item.status = "reserved"
            stock_item.reserved_by = order.id
            self._refresh_route(robot)
            self._event(
                f"Менеджер зарезервировал {stock_item.id} и назначил заказ {order.id} погрузчику {robot.id} (приоритет {order.priority}, оценка {score}).",
                "manager",
                robot_id=robot.id,
                order_id=order.id,
            )

    def _plan_route(
        self,
        start: Point,
        goal: Point,
        occupied: set[Point],
        extra_blocked: set[Point] | None = None,
    ) -> list[Point] | None:
        return self.robot_agent.plan_route(
            start=start,
            goal=goal,
            width=self.warehouse.width,
            height=self.warehouse.height,
            blocked=set(self.warehouse.obstacles) | self.zone_agent.blocked_cells | (extra_blocked or set()),
            occupied=occupied,
        )

    def _get_robot(self, robot_id: str) -> Robot:
        for robot in self.warehouse.robots:
            if robot.id == robot_id:
                return robot
        raise KeyError(f"Робот {robot_id} не найден")

    def _get_order(self, order_id: str) -> Order:
        for order in self.warehouse.orders:
            if order.id == order_id:
                return order
        raise KeyError(f"Заказ {order_id} не найден")

    def _get_stock_item(self, item_id: str | None) -> StockItem:
        if item_id:
            for item in self.warehouse.inventory:
                if item.id == item_id:
                    return item
        raise KeyError(f"Складская позиция {item_id or '(не задана)'} не найдена")

    def _event(self, message: str, source: str, **details: str) -> None:
        self.events.appendleft(
            {
                "id": f"evt-{self.tick_count}-{len(self.events)}-{datetime.now(UTC).timestamp():.3f}",
                "tick": self.tick_count,
                "time": datetime.now(UTC).isoformat(),
                "source": source,
                "message": message,
                **details,
            }
        )
