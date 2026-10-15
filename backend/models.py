"""Small, JSON-friendly data models used by the warehouse simulation."""

from dataclasses import asdict, dataclass, field
from typing import Literal

Point = tuple[int, int]
OrderStatus = Literal["pending", "assigned", "picking", "delivering", "completed"]
RobotStatus = Literal["idle", "moving", "waiting", "stopped"]
ItemSize = Literal["small", "medium", "large"]
StockStatus = Literal["available", "reserved", "picked", "delivered"]


@dataclass
class StockItem:
    id: str
    name: str
    position: Point
    size: ItemSize
    status: StockStatus = "available"
    reserved_by: str | None = None

    def to_dict(self) -> dict:
        result = asdict(self)
        result["position"] = list(self.position)
        return result


@dataclass
class Order:
    id: str
    item: str
    pickup: Point
    dropoff: Point
    item_id: str | None = None
    priority: int = 1
    status: OrderStatus = "pending"
    robot_id: str | None = None

    def to_dict(self) -> dict:
        result = asdict(self)
        result["pickup"] = list(self.pickup)
        result["dropoff"] = list(self.dropoff)
        return result


@dataclass
class Robot:
    id: str
    position: Point
    route: list[Point] = field(default_factory=list)
    status: RobotStatus = "idle"
    order_id: str | None = None
    carrying_item: bool = False
    stopped_by_operator: bool = False
    basket_capacity: int = 3
    basket_load: int = 0
    home: Point = (0, 0)
    kind: str = "forklift"
    driver_phase: str = "idle"
    route_version: int = 0

    def to_dict(self) -> dict:
        result = asdict(self)
        result["position"] = list(self.position)
        result["route"] = [list(point) for point in self.route]
        return result


@dataclass
class Warehouse:
    width: int
    height: int
    obstacles: list[Point]
    pickup_points: list[Point]
    shipping_points: list[Point]
    robots: list[Robot] = field(default_factory=list)
    orders: list[Order] = field(default_factory=list)
    inventory: list[StockItem] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "obstacles": [list(point) for point in self.obstacles],
            "pickup_points": [list(point) for point in self.pickup_points],
            "shipping_points": [list(point) for point in self.shipping_points],
            "robots": [robot.to_dict() for robot in self.robots],
            "orders": [order.to_dict() for order in self.orders],
            "inventory": [item.to_dict() for item in self.inventory],
        }
