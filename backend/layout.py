"""Versioned static layout contract; no agent decisions or mutable task state."""
from collections import deque
import re
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from backend.models import Warehouse, Robot, Rack, StorageLocation
from backend.rack_types import RACK_TYPES, rack_for_position, storage_address

class Cell(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    kind: Literal["rack", "wall", "pickup", "shipping", "robot"]
    levels: int = Field(default=1, ge=1, le=12)
    id: str | None = Field(default=None, min_length=1, max_length=40)
    rack_type: str | None = None
    width_mm: int | None = Field(default=None, gt=0, le=20000)
    depth_mm: int | None = Field(default=None, gt=0, le=10000)
    height_mm: int | None = Field(default=None, gt=0, le=15000)
    positions_per_level: int | None = Field(default=None, ge=1, le=100)
    width_m: float | None = Field(default=None, gt=0, exclude=True)
    depth_m: float | None = Field(default=None, gt=0, exclude=True)
    height_m: float | None = Field(default=None, gt=0, exclude=True)

    @model_validator(mode="before")
    @classmethod
    def rack_defaults(cls, data: object) -> object:
        if isinstance(data, dict) and data.get("kind") == "rack":
            result = dict(data)
            x, y = result.get("x", 0), result.get("y", 0)
            rack_type = result.get("rack_type")
            if rack_type not in RACK_TYPES:
                rack_type = "pallet_high" if y < 4 and x < 6 else "pallet_standard" if y < 4 else "medium_shelving" if x < 6 else "small_parts_shelving"
                result["rack_type"] = rack_type
            config = RACK_TYPES[rack_type]
            result.setdefault("levels", config.levels)
            if result.get("width_m") is not None:
                result["width_mm"] = round(result.pop("width_m") * 1000)
            if result.get("depth_m") is not None:
                result["depth_mm"] = round(result.pop("depth_m") * 1000)
            if result.get("height_m") is not None:
                result["height_mm"] = round(result.pop("height_m") * 1000)
            result.setdefault("id", f"A-{y + 1:02d}{x + 1:02d}" if isinstance(x, int) and isinstance(y, int) else None)
            result.setdefault("width_mm", config.width_mm)
            result.setdefault("depth_mm", config.depth_mm)
            result.setdefault("height_mm", config.height_mm)
            result.setdefault("positions_per_level", config.positions_per_level)
            return result
        return data

    @model_validator(mode="after")
    def complete_rack(self) -> "Cell":
        if self.kind == "rack" and any(value is None for value in (self.id, self.rack_type, self.width_mm, self.depth_mm, self.height_mm, self.positions_per_level)):
            raise ValueError("Стеллажу нужны ID, ширина, глубина и высота")
        if self.kind == "rack" and not re.fullmatch(r"[A-Z0-9]{1,8}-[A-Z0-9]{1,8}", self.id or ""):
            raise ValueError("ID стеллажа должен содержать две буквенно-цифровые части через дефис")
        if self.kind == "rack" and self.rack_type not in RACK_TYPES:
            raise ValueError("Неизвестный тип стеллажа")
        return self

class Layout(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1] = 1
    width: int = Field(ge=4, le=40)
    height: int = Field(ge=4, le=30)
    cells: list[Cell] = Field(max_length=1200)

    def errors(self) -> list[str]:
        errors = []
        occupied = set()
        rack_ids = set()
        for c in self.cells:
            point = (c.x, c.y)
            if c.x >= self.width or c.y >= self.height:
                errors.append(f"Объект {point} вне границ склада")
            if point in occupied:
                errors.append(f"Объекты пересекаются в {point}")
            occupied.add(point)
            if c.kind != "rack" and c.levels != 1:
                errors.append("Ярусы задаются только для стеллажей")
            if c.kind == "rack":
                if c.id in rack_ids:
                    errors.append(f"Повторяется ID стеллажа {c.id}")
                rack_ids.add(c.id)
                if c.levels * c.positions_per_level > 500:
                    errors.append(f"Слишком много мест хранения у стеллажа {c.id}")
            elif any(value is not None for value in (c.id, c.rack_type, c.width_mm, c.depth_mm, c.height_mm, c.positions_per_level, c.width_m, c.depth_m, c.height_m)):
                errors.append("Размеры и ID задаются только для стеллажей")
        for kind, label in [("robot", "стоянка техники"), ("pickup", "точка забора"), ("shipping", "отгрузка")]:
            if not any(c.kind == kind for c in self.cells):
                errors.append(f"Необходима хотя бы одна: {label}")
        blocked = {(c.x, c.y) for c in self.cells if c.kind in ("rack", "wall")}
        targets = [(c.x, c.y) for c in self.cells if c.kind in ("robot", "pickup", "shipping")]
        if targets and not errors:
            reached = {targets[0]}
            queue = deque(reached)
            while queue:
                x, y = queue.popleft()
                for q in [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]:
                    if 0 <= q[0] < self.width and 0 <= q[1] < self.height and q not in blocked and q not in reached:
                        reached.add(q)
                        queue.append(q)
            if any(t not in reached for t in targets):
                errors.append("Стоянки, забор и отгрузка должны соединяться проходами")
            for c in self.cells:
                if c.kind == "rack" and not any(q in reached for q in [(c.x+1,c.y),(c.x-1,c.y),(c.x,c.y+1),(c.x,c.y-1)]):
                    errors.append(f"Нет доступа к стеллажу {(c.x,c.y)}")
        return errors

    def warehouse(self) -> Warehouse:
        points = lambda kind: [(c.x,c.y) for c in self.cells if c.kind == kind]
        obstacles = points("rack") + points("wall")
        obstacle_set = set(obstacles)
        racks = [rack_for_position(c.id, (c.x, c.y), c.rack_type) for c in self.cells if c.kind == "rack"]
        for cell, rack in ((cell, rack) for cell in self.cells if cell.kind == "rack" for rack in racks if rack.id == cell.id):
            rack.width_mm = cell.width_mm
            rack.depth_mm = cell.depth_mm
            rack.height_mm = cell.height_mm
            rack.levels = cell.levels
            rack.positions_per_level = cell.positions_per_level
            neighbors = [(cell.x - 1, cell.y), (cell.x + 1, cell.y), (cell.x, cell.y + 1), (cell.x, cell.y - 1)]
            rack.service_point = next((p for p in neighbors if 0 <= p[0] < self.width and 0 <= p[1] < self.height and p not in obstacle_set), None)
        locations = [
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
                y_mm=0,
            )
            for rack in racks
            for level in range(1, rack.levels + 1)
            for position in range(1, rack.positions_per_level + 1)
        ]
        return Warehouse(width=self.width, height=self.height,
            obstacles=points("rack") + points("wall"), pickup_points=points("pickup"),
            shipping_points=points("shipping"), robots=[Robot(id=f"R-{i:02d}", position=p, home=p) for i,p in enumerate(points("robot"),1)],
            racks=racks, storage_locations=locations)


def from_warehouse(w: Warehouse) -> Layout:
    rack_points = {rack.position for rack in w.racks}
    cells = [Cell(x=r.position[0], y=r.position[1], kind="rack", id=r.id, rack_type=r.rack_type, width_mm=r.width_mm, depth_mm=r.depth_mm, height_mm=r.height_mm, levels=r.levels, positions_per_level=r.positions_per_level) for r in w.racks]
    cells += [Cell(x=x,y=y,kind=k) for k,points in [("wall",[p for p in w.obstacles if p not in rack_points]),("pickup",w.pickup_points),("shipping",w.shipping_points),("robot",[r.home for r in w.robots])] for x,y in points]
    return Layout(width=w.width,height=w.height,cells=cells)
