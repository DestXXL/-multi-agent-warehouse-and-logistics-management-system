"""Warehouse simulation coordinated by deterministic software agents."""

from collections import deque
from datetime import UTC, datetime

from backend.agents import ManagerAgent, RobotAgent, ZoneAgent
from backend.models import Order, Point, Robot, StockItem, Warehouse, StorageLocation, StockAllocation
from backend.rack_types import (
    RACK_TYPES,
    demo_racks,
    generated_cargo_dimensions,
    pack_packages,
    storage_address,
)


class WarehouseSimulation:
    TICK_SECONDS = 1.0

    def __init__(self) -> None:
        self.manager_agent = ManagerAgent()
        self.robot_agent = RobotAgent()
        self.zone_agent = ZoneAgent()
        self.custom_layout = None
        self.reset()

    def reset(self) -> None:
        prior_inventory = self.warehouse.inventory if hasattr(self, "warehouse") else []
        obstacles = [(x, y) for x in range(4, 8) for y in (1, 2, 4, 5)]
        racks = demo_racks(obstacles)
        obstacle_set = set(obstacles)
        for rack in racks:
            x, y = rack.position
            rack.service_point = next((p for p in [(x - 1, y), (x + 1, y), (x, y + 1), (x, y - 1)] if 0 <= p[0] < 12 and 0 <= p[1] < 8 and p not in obstacle_set), None)
        rack_by_id = {rack.id: rack for rack in racks}
        storage_locations = [
            StorageLocation(
                id=f"{rack.id}-L{level:02d}-P{position:02d}",
                rack_id=rack.id,
                level=level,
                position=position,
                address=storage_address(rack.id, level, position),
                width_mm=rack.width_mm // rack.positions_per_level,
                depth_mm=rack.depth_mm,
                max_height_mm=rack.height_mm // rack.levels,
                x_mm=(position - 1) * (rack.width_mm // rack.positions_per_level),
            )
            for rack in racks
            for level in range(1, rack.levels + 1)
            for position in range(1, rack.positions_per_level + 1)
        ]
        self.warehouse = Warehouse(
            width=12,
            height=8,
            obstacles=obstacles,
            racks=racks,
            storage_locations=storage_locations,
            pickup_points=[(3, 1), (3, 6), (8, 1), (8, 6)],
            shipping_points=[(11, 1), (11, 6)],
            robots=[Robot(id="R-01", position=(0, 1), home=(0, 1)), Robot(id="R-02", position=(0, 6), home=(0, 6))],
            orders=[
                Order(id="ORD-001", item="Коробка A-14", pickup=rack_by_id["A-01"].service_point, dropoff=(11, 1), item_id="SKU-001", product_id="SKU-001", quantity=3, priority=3),
                Order(id="ORD-002", item="Коробка B-07", pickup=rack_by_id["A-05"].service_point, dropoff=(11, 6), item_id="SKU-002", product_id="SKU-002", priority=2),
                Order(id="ORD-003", item="Коробка C-22", pickup=rack_by_id["A-03"].service_point, dropoff=(11, 6), product_id="SKU-003", quantity=5, priority=1),
            ],
            inventory=[
                StockItem(id="SKU-001", name="Коробка A-14", position=rack_by_id["A-01"].service_point, size="small", product_id="SKU-001", location_id="A-01-L01-P01", quantity=12, length_mm=200, width_mm=150, height_mm=100),
                StockItem(id="SKU-002", name="Коробка B-07", position=rack_by_id["A-05"].service_point, size="medium", product_id="SKU-002", location_id="A-05-L01-P01", quantity=8, length_mm=400, width_mm=300, height_mm=250),
                StockItem(id="SKU-003-A03", name="Коробка C-22", position=rack_by_id["A-03"].service_point, size="large", product_id="SKU-003", location_id="A-03-L01-P01", quantity=3, length_mm=400, width_mm=200, height_mm=200),
                StockItem(id="SKU-003-A04", name="Коробка C-22", position=rack_by_id["A-04"].service_point, size="large", product_id="SKU-003", location_id="A-04-L01-P01", quantity=2, length_mm=400, width_mm=200, height_mm=200),
            ],
        )
        if self.custom_layout is not None:
            replacement = self.custom_layout.warehouse()
            location_ids = {location.id for location in replacement.storage_locations}
            replacement.inventory = [item for item in prior_inventory if item.location_id in location_ids]
            for item in replacement.inventory:
                location = next(location for location in replacement.storage_locations if location.id == item.location_id)
                rack = next(rack for rack in replacement.racks if rack.id == location.rack_id)
                item.position = rack.service_point or rack.position
            self.warehouse = replacement
        self._initialize_stock_placements()
        self.running = False
        self.zone_agent.clear()
        self.tick_count = 0
        self.next_order_number = 4
        self.events: deque[dict] = deque(maxlen=100)
        self._event("Склад подготовлен. Ожидается запуск симуляции.", "system")

    def _occupied_rectangles(self, location_id: str) -> list[dict]:
        return [
            rectangle
            for stock in self.warehouse.inventory
            if stock.location_id == location_id and stock.quantity > 0
            for rectangle in stock.unit_placements
        ]

    def _initialize_stock_placements(self) -> None:
        for stock in self.warehouse.inventory:
            if stock.quantity <= 0 or stock.unit_placements:
                continue
            location = next((item for item in self.warehouse.storage_locations if item.id == stock.location_id), None)
            if location is None:
                raise ValueError(f"Для товара {stock.id} не найден адрес хранения {stock.location_id}")
            placements = pack_packages(
                (stock.length_mm, stock.width_mm, stock.height_mm),
                stock.quantity,
                location,
                self._occupied_rectangles(location.id),
            )
            if len(placements) != stock.quantity:
                raise ValueError(f"Товар {stock.name} не помещается на место {location.address}")
            stock.unit_placements = placements
            stock.placement_x_mm = placements[0]["x_mm"]
            stock.placement_y_mm = placements[0]["y_mm"]
            stock.rotated = placements[0]["rotated"]

    def state(self) -> dict:
        warehouse = self.warehouse.to_dict()
        stocks_by_location: dict[str, list[StockItem]] = {}
        for item in self.warehouse.inventory:
            if item.location_id:
                stocks_by_location.setdefault(item.location_id, []).append(item)
        occupied = 0
        for location in warehouse["storage_locations"]:
            stocks = [item for item in stocks_by_location.get(location["id"], []) if item.quantity > 0]
            stock = stocks[0] if stocks else None
            location["item"] = None if stock is None else {
                "id": stock.product_id or stock.id,
                "name": stock.name,
                "quantity": stock.quantity,
                "reserved_quantity": sum(stock.reservations.values()),
                "available_quantity": stock.quantity - sum(stock.reservations.values()),
                "length_mm": stock.length_mm,
                "width_mm": stock.width_mm,
                "height_mm": stock.height_mm,
                "rotated": stock.rotated,
                "placement_x_mm": stock.placement_x_mm,
                "placement_y_mm": stock.placement_y_mm,
                "unit_placements": stock.unit_placements,
            }
            location["items"] = [
                {
                    "id": item.product_id or item.id,
                    "name": item.name,
                    "quantity": item.quantity,
                    "length_mm": item.length_mm,
                    "width_mm": item.width_mm,
                    "height_mm": item.height_mm,
                    "unit_placements": item.unit_placements,
                }
                for item in stocks
            ]
            location["package_count"] = sum(item.quantity for item in stocks)
            location["used_surface_mm2"] = sum(
                rectangle["length_mm"] * rectangle["width_mm"]
                for stock in stocks
                for rectangle in stock.unit_placements
            )
            location["free_surface_mm2"] = max(0, location["width_mm"] * location["depth_mm"] - location["used_surface_mm2"])
            location["occupied"] = stock is not None
            if stock is not None:
                occupied += 1
        for rack in warehouse["racks"]:
            rack_locations = [location for location in warehouse["storage_locations"] if location["rack_id"] == rack["id"]]
            rack_type = RACK_TYPES[rack["rack_type"]]
            rack["rack_type_title"] = rack_type.title
            rack["purpose"] = rack_type.purpose
            rack["occupied_locations"] = sum(location["occupied"] for location in rack_locations)
            rack["free_locations"] = sum(location["enabled"] and not location["occupied"] for location in rack_locations)
            rack["location_count"] = len(rack_locations)
            rack["capacity_percent"] = round(100 * rack["occupied_locations"] / len(rack_locations)) if rack_locations else 0
            rack["package_count"] = sum(location["package_count"] for location in rack_locations)
            rack["free_surface_mm2"] = sum(location["free_surface_mm2"] for location in rack_locations)
            rack["levels_occupancy"] = [
                {
                    "level": level,
                    "occupied": sum(location["occupied"] for location in rack_locations if location["level"] == level),
                    "total": sum(location["enabled"] for location in rack_locations if location["level"] == level),
                    "packages": sum(location["package_count"] for location in rack_locations if location["level"] == level),
                    "free_surface_mm2": sum(location["free_surface_mm2"] for location in rack_locations if location["level"] == level),
                }
                for level in range(1, rack["levels"] + 1)
            ]
        stock_by_product = {}
        for stock in self.warehouse.inventory:
            stock_by_product.setdefault(stock.product_id or stock.id, stock)
        for order_data, order in zip(warehouse["orders"], self.warehouse.orders):
            stock = stock_by_product.get(order.product_id or "")
            order_data["length_mm"] = order.length_mm if order.length_mm is not None else (stock.length_mm if stock else None)
            order_data["width_mm"] = order.width_mm if order.width_mm is not None else (stock.width_mm if stock else None)
            order_data["height_mm"] = order.height_mm if order.height_mm is not None else (stock.height_mm if stock else None)
        for data, robot in zip(warehouse["robots"], self.warehouse.robots):
            data["can_report_obstacle"] = self._report_point(robot) is not None
        warehouse["closed_cells"] = [list(point) for point in sorted(self.zone_agent.blocked_cells)]
        return {
            "running": self.running,
            "tick": self.tick_count,
            "can_create_congestion": self._congestion_candidate() is not None,
            "warehouse": warehouse,
            "storage_summary": {"locations": len(warehouse["storage_locations"]), "occupied": occupied, "free": len(warehouse["storage_locations"]) - occupied},
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

    def add_order(
        self,
        item: str,
        pickup: Point,
        dropoff: Point,
        product_id: str | None = None,
        quantity: int = 1,
        dimensions: tuple[int, int, int] | None = None,
    ) -> dict:
        order_id = f"ORD-{self.next_order_number:03d}"
        if quantity < 1:
            raise ValueError("Количество товара должно быть положительным")
        if product_id is None:
            dimensions = dimensions or generated_cargo_dimensions(self.next_order_number)
            if any(not isinstance(value, int) or value <= 0 for value in dimensions):
                raise ValueError("Габариты груза должны быть положительными целыми числами в миллиметрах")
            planned = self.manager_agent.choose_storage_positions(
                dimensions,
                quantity,
                self.warehouse.storage_locations,
                self.warehouse.inventory,
            )
            if planned is None:
                raise ValueError(f"Нет свободной ячейки хранения, подходящей для груза {dimensions[0]} × {dimensions[1]} × {dimensions[2]} мм")
            product_id = f"SKU-{self.next_order_number:03d}"
            size = "small" if max(dimensions) <= 250 else "medium" if max(dimensions) <= 500 else "large"
            created: list[StockItem] = []
            for index, (location, placements) in enumerate(planned):
                rack = next(rack for rack in self.warehouse.racks if rack.id == location.rack_id)
                stock_id = product_id if index == 0 else f"{product_id}@{location.id}"
                stock = StockItem(
                    id=stock_id, name=item, position=rack.service_point or rack.position, size=size,
                    product_id=product_id, location_id=location.id, quantity=len(placements),
                    length_mm=dimensions[0], width_mm=dimensions[1], height_mm=dimensions[2],
                    placement_x_mm=placements[0]["x_mm"], placement_y_mm=placements[0]["y_mm"],
                    rotated=placements[0]["rotated"], unit_placements=placements,
                )
                self.warehouse.inventory.append(stock)
                created.append(stock)
            item_id = created[0].id
            pickup = created[0].position
        else:
            item_id = None
            matching = [stock for stock in self.warehouse.inventory if (stock.product_id or stock.id) == product_id]
            available = sum(stock.quantity - sum(stock.reservations.values()) for stock in matching)
            if available < quantity:
                raise ValueError(f"Недостаточно товара {product_id}: доступно {available}, требуется {quantity}")
            if dimensions is not None and any((stock.length_mm, stock.width_mm, stock.height_mm) != dimensions for stock in matching):
                raise ValueError("Габариты существующего товара нельзя переопределить в заказе")
            if matching:
                dimensions = (matching[0].length_mm, matching[0].width_mm, matching[0].height_mm)
        order = Order(
            id=order_id,
            item=item,
            pickup=pickup,
            dropoff=dropoff,
            item_id=item_id,
            product_id=product_id,
            quantity=quantity,
            length_mm=dimensions[0] if dimensions else None,
            width_mm=dimensions[1] if dimensions else None,
            height_mm=dimensions[2] if dimensions else None,
        )
        self.next_order_number += 1
        self.warehouse.orders.append(order)
        self._event(f"Создан заказ {order.id}: {item}.", "operator", order_id=order.id)
        return self.state()

    def resize_product(self, item_id: str, dimensions: tuple[int, int, int]) -> dict:
        selected = next((item for item in self.warehouse.inventory if item.id == item_id), None)
        if selected is None:
            raise KeyError(f"Складская позиция {item_id} не найдена")
        if any(not isinstance(value, int) or value <= 0 for value in dimensions):
            raise ValueError("Габариты груза должны быть положительными целыми числами в миллиметрах")
        product_id = selected.product_id or selected.id
        product_items = [item for item in self.warehouse.inventory if (item.product_id or item.id) == product_id]
        if any(item.reservations for item in product_items):
            raise ValueError("Нельзя менять размеры товара, зарезервированного для активного задания")
        planned: dict[str, list[dict]] = {}
        by_location: dict[str, list[StockItem]] = {}
        for item in self.warehouse.inventory:
            if item.quantity > 0 and item.location_id:
                by_location.setdefault(item.location_id, []).append(item)
        locations = {location.id: location for location in self.warehouse.storage_locations}
        for location_id, stocks in by_location.items():
            location = locations[location_id]
            occupied = []
            for stock in stocks:
                size = dimensions if (stock.product_id or stock.id) == product_id else (stock.length_mm, stock.width_mm, stock.height_mm)
                placements = pack_packages(size, stock.quantity, location, occupied)
                if len(placements) != stock.quantity:
                    raise ValueError(f"Новые размеры {dimensions[0]} × {dimensions[1]} × {dimensions[2]} мм не помещаются в {location.address}")
                planned[stock.id] = placements
                occupied.extend(placements)
        for stock in product_items:
            stock.length_mm, stock.width_mm, stock.height_mm = dimensions
            if stock.id in planned:
                stock.unit_placements = planned[stock.id]
                first = stock.unit_placements[0]
                stock.placement_x_mm, stock.placement_y_mm, stock.rotated = first["x_mm"], first["y_mm"], first["rotated"]
        for order in self.warehouse.orders:
            if order.product_id == product_id and order.status not in ("completed", "cancelled"):
                order.length_mm, order.width_mm, order.height_mm = dimensions
        self._event(f"Размеры товара {product_id} изменены на {dimensions[0]} × {dimensions[1]} × {dimensions[2]} мм.", "operator")
        return self.state()

    def cancel_order(self, order_id: str) -> dict:
        order = self._get_order(order_id)
        if order.status in ("completed", "cancelled"):
            raise ValueError("Завершённый или отменённый заказ нельзя отменить повторно")
        for allocation in order.allocations:
            stock = self._get_stock_item(allocation.stock_item_id)
            reserved = stock.reservations.pop(order.id, 0)
            stock.reserved_placements.pop(order.id, None)
            if reserved:
                stock.reserved_by = next(iter(stock.reservations), None)
            if allocation.picked:
                stock.quantity += allocation.quantity
                stock.unit_placements.extend(allocation.placement_snapshot)
                stock.unit_placements.sort(key=lambda rectangle: (rectangle["y_mm"], rectangle["x_mm"]))
                allocation.picked = False
            self._sync_stock_status(stock)
        robot = next((resource for resource in self.warehouse.robots if resource.order_id == order.id), None)
        if robot:
            robot.carrying_item = False
            robot.basket_load = 0
            robot.order_id = None
            robot.driver_phase = "returning"
            self._refresh_route(robot)
        order.status = "cancelled"
        self._event(f"Заказ {order.id} отменён. Резервы сняты, остатки восстановлены по адресам хранения.", "operator", order_id=order.id)
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
        destination = order.dropoff if robot.driver_phase in ("to_dropoff", "confirm_delivery") else self._current_pickup_point(order)
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
        if robot.stopped_by_operator:
            raise ValueError("Сначала возобновите работу погрузчика")
        if action == "accept" and robot.driver_phase == "offered":
            robot.driver_phase = "to_pickup"
            message = "принял задание"
        elif action == "pickup" and robot.driver_phase == "confirm_pickup" and robot.position == order.pickup:
            allocation = self._current_allocation(order)
            if allocation is None:
                raise ValueError("В задании не осталось мест отбора")
            stock = self._get_stock_item(allocation.stock_item_id)
            reserved = stock.reservations.get(order.id, 0)
            if reserved < allocation.quantity or stock.quantity < allocation.quantity:
                raise ValueError("Резерв или остаток товара не соответствует заданию")
            reserved_placements = stock.reserved_placements.get(order.id, [])
            if len(reserved_placements) < allocation.quantity:
                raise ValueError("Физические места груза не соответствуют резерву")
            before = stock.quantity
            stock.quantity -= allocation.quantity
            stock.reservations.pop(order.id, None)
            stock.reserved_placements.pop(order.id, None)
            allocation.placement_snapshot = list(reserved_placements[:allocation.quantity])
            stock.unit_placements = [rectangle for rectangle in stock.unit_placements if not any(rectangle == reserved for reserved in allocation.placement_snapshot)]
            if stock.unit_placements:
                stock.placement_x_mm = stock.unit_placements[0]["x_mm"]
                stock.placement_y_mm = stock.unit_placements[0]["y_mm"]
                stock.rotated = stock.unit_placements[0]["rotated"]
            stock.reserved_by = next(iter(stock.reservations), None)
            allocation.picked = True
            self._sync_stock_status(stock)
            order.picked_quantity += allocation.quantity
            robot.carrying_item = True
            robot.basket_load = self.manager_agent.ITEM_LOAD[stock.size]
            order.allocation_index += 1
            if order.allocation_index < len(order.allocations):
                next_allocation = self._current_allocation(order)
                next_stock = self._get_stock_item(next_allocation.stock_item_id)
                order.storage_location_id = next_allocation.storage_location_id
                order.pickup = next_stock.position
                robot.driver_phase = "to_pickup"
                message = f"подтвердил отбор {allocation.quantity} шт. по адресу {self._location_address(allocation.storage_location_id)}; следующий адрес {self._location_address(next_allocation.storage_location_id)}"
            else:
                robot.driver_phase = "to_dropoff"
                order.status = "delivering"
                message = f"подтвердил отбор {allocation.quantity} шт. по адресу {self._location_address(allocation.storage_location_id)}; остаток {before} → {stock.quantity}"
        elif action == "deliver" and robot.driver_phase == "confirm_delivery" and robot.position == order.dropoff:
            for allocation in order.allocations:
                stock = self._get_stock_item(allocation.stock_item_id)
                if allocation.picked and stock.quantity == 0:
                    stock.status = "delivered"
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

    def _current_allocation(self, order: Order) -> StockAllocation | None:
        if 0 <= order.allocation_index < len(order.allocations):
            return order.allocations[order.allocation_index]
        return None

    def _current_pickup_point(self, order: Order) -> Point:
        allocation = self._current_allocation(order)
        if allocation:
            return self._get_stock_item(allocation.stock_item_id).position
        return order.pickup

    def _location_address(self, location_id: str) -> str:
        location = next((item for item in self.warehouse.storage_locations if item.id == location_id), None)
        return location.address if location else location_id

    @staticmethod
    def _sync_stock_status(stock: StockItem) -> None:
        if stock.quantity <= 0:
            stock.status = "picked"
        elif stock.reservations:
            stock.status = "reserved"
        else:
            stock.status = "available"

    def _congestion_candidate(self) -> tuple[Robot, Point, list[Point]] | None:
        candidates = [robot for robot in self.warehouse.robots if len(robot.route) >= 3 and not robot.stopped_by_operator]
        selected: tuple[Robot, Point, list[Point]] | None = None
        for robot in candidates:
            if not robot.order_id:
                continue
            order = self._get_order(robot.order_id)
            goal = self._current_pickup_point(order) if robot.driver_phase == "to_pickup" else order.dropoff
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
            destination = self._current_pickup_point(order) if robot.driver_phase == "to_pickup" else order.dropoff
            if robot.position != destination:
                occupied.discard(robot.position)
                route = self._plan_route(robot.position, destination, occupied)
                if route:
                    robot.position = route[0]
                    robot.route = route[1:]
                    robot.status = "moving"
                else:
                    robot.route = []
                    robot.status = "waiting"
                occupied.add(robot.position)
            if robot.position == destination:
                arriving_at_pickup = robot.driver_phase == "to_pickup"
                robot.driver_phase = "confirm_pickup" if arriving_at_pickup else "confirm_delivery"
                robot.status = "waiting"
                robot.route = []
                if arriving_at_pickup:
                    order.status = "picking"
                address = self._location_address(order.storage_location_id) if arriving_at_pickup and order.storage_location_id else ""
                action = f" к адресу {address}" if address else ""
                self._event(f"{robot.id} прибыл к точке обслуживания{action} ({destination}). Требуется подтверждение водителя.", "system", robot_id=robot.id, order_id=order.id)

        return self.state()

    def _assign_orders(self) -> None:
        pending_orders = sorted(
            (order for order in self.warehouse.orders if order.status == "pending"),
            key=lambda order: (-order.priority, order.id),
        )
        for order in pending_orders:
            if not order.product_id:
                stock_item = self._get_stock_item(order.item_id)
                order.product_id = stock_item.product_id or stock_item.id
            if order.length_mm is None or order.width_mm is None or order.height_mm is None:
                matching = next((item for item in self.warehouse.inventory if item.product_id == order.product_id), None)
                if matching:
                    order.length_mm, order.width_mm, order.height_mm = matching.length_mm, matching.width_mm, matching.height_mm
            assignment = self.manager_agent.choose_storage_assignment(
                order,
                self.warehouse.inventory,
                self.warehouse.robots,
                self._route_cost,
            )
            if assignment is None:
                continue
            robot, score, allocations = assignment
            order.allocations = allocations
            order.allocation_index = 0
            order.storage_location_id = allocations[0].storage_location_id
            order.item_id = allocations[0].stock_item_id
            order.pickup = self._get_stock_item(order.item_id).position
            for allocation in allocations:
                stock_item = self._get_stock_item(allocation.stock_item_id)
                stock_item.reservations[order.id] = allocation.quantity
                stock_item.reserved_by = order.id
                unavailable = [rectangle for rows in stock_item.reserved_placements.values() for rectangle in rows]
                available = [rectangle for rectangle in stock_item.unit_placements if rectangle not in unavailable]
                if len(available) < allocation.quantity:
                    raise ValueError(f"Недостаточно свободных коробок на адресе {self._location_address(allocation.storage_location_id)}")
                selected_placements = available[:allocation.quantity]
                stock_item.reserved_placements[order.id] = selected_placements
                allocation.placement_snapshot = list(selected_placements)
                self._sync_stock_status(stock_item)
            robot.order_id = order.id
            robot.driver_phase = "offered"
            robot.status = "waiting"
            order.robot_id = robot.id
            order.status = "assigned"
            self._refresh_route(robot)
            address_list = ", ".join(f"{self._location_address(allocation.storage_location_id)} ({allocation.quantity} шт.)" for allocation in allocations)
            self._event(
                f"Для {order.item} найдено {order.quantity} шт. по адресам {address_list}. Менеджер назначил {robot.id} и зарезервировал остаток (оценка {score}).",
                "manager",
                robot_id=robot.id,
                order_id=order.id,
            )

    def _route_cost(self, start: Point, goal: Point, occupied: set[Point]) -> int | None:
        route = self._plan_route(start, goal, occupied)
        return None if route is None else len(route)

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
