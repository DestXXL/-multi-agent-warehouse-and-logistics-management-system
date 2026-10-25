"""Small, JSON-friendly data models used by the warehouse simulation."""

from dataclasses import asdict, dataclass, field
from typing import Literal

Point = tuple[int, int]
OrderStatus = Literal["pending", "assigned", "picking", "delivering", "completed", "cancelled"]
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
    product_id: str | None = None
    location_id: str | None = None
    quantity: int = 1
    reservations: dict[str, int] = field(default_factory=dict)
    length_mm: int | None = None
    width_mm: int | None = None
    height_mm: int | None = None
    placement_x_mm: int = 0
    placement_y_mm: int = 0
    rotated: bool = False
    unit_placements: list[dict] = field(default_factory=list)
    reserved_placements: dict[str, list[dict]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Older saved stock rows have no dimensions. Give them a conservative
        # profile based on their existing size without changing rack geometry.
        defaults = {"small": (200, 150, 100), "medium": (400, 300, 250), "large": (400, 200, 200)}
        length, width, height = defaults.get(self.size, defaults["medium"])
        self.length_mm = length if self.length_mm is None else self.length_mm
        self.width_mm = width if self.width_mm is None else self.width_mm
        self.height_mm = height if self.height_mm is None else self.height_mm

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
    product_id: str | None = None
    quantity: int = 1
    storage_location_id: str | None = None
    allocations: list["StockAllocation"] = field(default_factory=list)
    allocation_index: int = 0
    picked_quantity: int = 0
    length_mm: int | None = None
    width_mm: int | None = None
    height_mm: int | None = None

    def to_dict(self) -> dict:
        result = asdict(self)
        result["pickup"] = list(self.pickup)
        result["dropoff"] = list(self.dropoff)
        result["allocations"] = [allocation.to_dict() for allocation in self.allocations]
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
class Rack:
    id: str
    rack_type: str
    position: Point
    width_mm: int
    depth_mm: int
    height_mm: int
    levels: int = 5
    positions_per_level: int = 2
    service_point: Point | None = None

    def to_dict(self) -> dict:
        result = asdict(self)
        result["position"] = list(self.position)
        result["service_point"] = list(self.service_point) if self.service_point else None
        return result


@dataclass
class StorageLocation:
    id: str
    rack_id: str
    level: int
    position: int
    address: str
    enabled: bool = True
    width_mm: int = 0
    depth_mm: int = 0
    max_height_mm: int = 0
    x_mm: int = 0
    y_mm: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class StockAllocation:
    stock_item_id: str
    storage_location_id: str
    quantity: int
    picked: bool = False
    placement_snapshot: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Warehouse:
    width: int
    height: int
    obstacles: list[Point]
    pickup_points: list[Point]
    shipping_points: list[Point]
    robots: list[Robot] = field(default_factory=list)
    racks: list[Rack] = field(default_factory=list)
    storage_locations: list[StorageLocation] = field(default_factory=list)
    orders: list[Order] = field(default_factory=list)
    inventory: list[StockItem] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict) -> "Warehouse":
        """Restore a JSON snapshot, including package positions and reservations."""
        robots = [
            Robot(**{
                **row,
                "position": tuple(row["position"]),
                "route": [tuple(point) for point in row.get("route", [])],
                "home": tuple(row.get("home", row["position"])),
            })
            for row in data.get("robots", [])
        ]
        racks = [Rack(**{**row, "position": tuple(row["position"]), "service_point": tuple(row["service_point"]) if row.get("service_point") else None}) for row in data.get("racks", [])]
        locations = [StorageLocation(**row) for row in data.get("storage_locations", [])]
        racks_by_id = {rack.id: rack for rack in racks}
        for location in locations:
            rack = racks_by_id.get(location.rack_id)
            if rack:
                location.width_mm = location.width_mm or rack.width_mm // rack.positions_per_level
                location.depth_mm = location.depth_mm or rack.depth_mm
                location.max_height_mm = location.max_height_mm or rack.height_mm // rack.levels
                location.x_mm = location.x_mm or (location.position - 1) * location.width_mm
        orders = [
            Order(**{
                **row,
                "pickup": tuple(row["pickup"]),
                "dropoff": tuple(row["dropoff"]),
                "allocations": [StockAllocation(**allocation) for allocation in row.get("allocations", [])],
            })
            for row in data.get("orders", [])
        ]
        inventory = [
            StockItem(**{
                **row,
                "position": tuple(row["position"]),
                "reservations": dict(row.get("reservations", {})),
            })
            for row in data.get("inventory", [])
        ]
        from backend.rack_types import pack_packages

        locations_by_id = {location.id: location for location in locations}
        stocks_by_location: dict[str, list[StockItem]] = {}
        for stock in inventory:
            if stock.quantity > 0 and stock.location_id in locations_by_id:
                stocks_by_location.setdefault(stock.location_id, []).append(stock)

        for location_id, stocks in stocks_by_location.items():
            location = locations_by_id[location_id]
            rectangles: list[dict] = []
            reflow_required = False
            for stock in stocks:
                if len(stock.unit_placements) != stock.quantity:
                    reflow_required = True
                for rectangle in stock.unit_placements:
                    if not isinstance(rectangle, dict):
                        reflow_required = True
                        continue
                    if type(rectangle.get("rotated", False)) is not bool:
                        reflow_required = True
                    rotated = bool(rectangle.get("rotated", False))
                    expected_length = stock.width_mm if rotated else stock.length_mm
                    expected_width = stock.length_mm if rotated else stock.width_mm
                    values = (rectangle.get("x_mm"), rectangle.get("y_mm"), rectangle.get("length_mm"), rectangle.get("width_mm"), rectangle.get("height_mm"))
                    if any(type(value) is not int for value in values):
                        reflow_required = True
                        continue
                    x, y, length, width, height = values
                    if (
                        length != expected_length or width != expected_width
                        or height != stock.height_mm or height > location.max_height_mm
                        or x < 0 or y < 0 or x + length > location.width_mm or y + width > location.depth_mm
                    ):
                        reflow_required = True
                    rectangles.append(rectangle)
            for index, first in enumerate(rectangles):
                for second in rectangles[index + 1:]:
                    if (
                        first["x_mm"] < second["x_mm"] + second["length_mm"]
                        and first["x_mm"] + first["length_mm"] > second["x_mm"]
                        and first["y_mm"] < second["y_mm"] + second["width_mm"]
                        and first["y_mm"] + first["width_mm"] > second["y_mm"]
                    ):
                        reflow_required = True
                        break

            if not reflow_required:
                continue

            occupied: list[dict] = []
            for stock in stocks:
                placements = pack_packages(
                    (stock.length_mm, stock.width_mm, stock.height_mm), stock.quantity, location, occupied,
                )
                if len(placements) != stock.quantity:
                    raise ValueError(f"Товар {stock.name} не помещается в восстановленный адрес {location.address}")
                stock.unit_placements = placements
                stock.placement_x_mm = placements[0]["x_mm"]
                stock.placement_y_mm = placements[0]["y_mm"]
                stock.rotated = placements[0]["rotated"]
                occupied.extend(placements)

                reassigned_reservations: dict[str, list[dict]] = {}
                cursor = 0
                for order_id, quantity in stock.reservations.items():
                    if quantity < 0 or cursor + quantity > len(placements):
                        raise ValueError(f"Резерв товара {stock.name} не согласован с его количеством")
                    reassigned_reservations[order_id] = placements[cursor:cursor + quantity]
                    cursor += quantity
                stock.reserved_placements = reassigned_reservations
                for order in orders:
                    if order.id not in reassigned_reservations:
                        continue
                    for allocation in order.allocations:
                        if allocation.stock_item_id == stock.id and not allocation.picked:
                            allocation.placement_snapshot = list(reassigned_reservations[order.id])
        return cls(
            width=data["width"],
            height=data["height"],
            obstacles=[tuple(point) for point in data.get("obstacles", [])],
            pickup_points=[tuple(point) for point in data.get("pickup_points", [])],
            shipping_points=[tuple(point) for point in data.get("shipping_points", [])],
            robots=robots,
            racks=racks,
            storage_locations=locations,
            orders=orders,
            inventory=inventory,
        )

    def to_dict(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "obstacles": [list(point) for point in self.obstacles],
            "pickup_points": [list(point) for point in self.pickup_points],
            "shipping_points": [list(point) for point in self.shipping_points],
            "robots": [robot.to_dict() for robot in self.robots],
            "racks": [rack.to_dict() for rack in self.racks],
            "storage_locations": [location.to_dict() for location in self.storage_locations],
            "orders": [order.to_dict() for order in self.orders],
            "inventory": [item.to_dict() for item in self.inventory],
        }
