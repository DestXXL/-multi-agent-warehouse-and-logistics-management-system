"""Versioned static layout contract; no agent decisions or mutable task state."""
from collections import deque
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from backend.models import Warehouse, Robot

class Cell(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    kind: Literal["rack", "wall", "pickup", "shipping", "robot"]
    levels: int = Field(default=1, ge=1, le=12)

class Layout(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1] = 1
    width: int = Field(ge=4, le=40)
    height: int = Field(ge=4, le=30)
    cells: list[Cell] = Field(max_length=1200)

    def errors(self) -> list[str]:
        errors = []
        occupied = set()
        for c in self.cells:
            point = (c.x, c.y)
            if c.x >= self.width or c.y >= self.height:
                errors.append(f"Объект {point} вне границ склада")
            if point in occupied:
                errors.append(f"Объекты пересекаются в {point}")
            occupied.add(point)
            if c.kind != "rack" and c.levels != 1:
                errors.append("Ярусы задаются только для стеллажей")
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
        return Warehouse(width=self.width, height=self.height,
            obstacles=points("rack") + points("wall"), pickup_points=points("pickup"),
            shipping_points=points("shipping"), robots=[Robot(id=f"R-{i:02d}", position=p, home=p) for i,p in enumerate(points("robot"),1)])


def from_warehouse(w: Warehouse) -> Layout:
    cells = [Cell(x=x,y=y,kind=k) for k,points in [("rack",w.obstacles),("pickup",w.pickup_points),("shipping",w.shipping_points),("robot",[r.home for r in w.robots])] for x,y in points]
    return Layout(width=w.width,height=w.height,cells=cells)
