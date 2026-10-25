"""Demonstration rack configurations and stable address helpers."""

from dataclasses import dataclass

from backend.models import Point, Rack

CARGO_PROFILES: tuple[tuple[int, int, int], ...] = (
    (200, 150, 100),
    (400, 300, 250),
    (600, 400, 350),
    (800, 600, 500),
)


def generated_cargo_dimensions(sequence: int) -> tuple[int, int, int]:
    """Cycle through realistic box profiles for automatically created orders."""
    return CARGO_PROFILES[(sequence - 1) % len(CARGO_PROFILES)]


def package_fits_location(
    dimensions: tuple[int, int, int], location: object, *, allow_rotation: bool = True,
) -> bool:
    """Check a package against one exclusive, non-stackable storage bay."""
    length, width, height = dimensions
    bay_width = getattr(location, "width_mm")
    bay_depth = getattr(location, "depth_mm")
    bay_height = getattr(location, "max_height_mm")
    if height > bay_height:
        return False
    if length <= bay_width and width <= bay_depth:
        return True
    return allow_rotation and width <= bay_width and length <= bay_depth


def package_rotation_for_location(
    dimensions: tuple[int, int, int], location: object,
) -> bool:
    """Return whether the fitting orientation swaps the horizontal sides."""
    length, width, height = dimensions
    bay_width = getattr(location, "width_mm")
    bay_depth = getattr(location, "depth_mm")
    bay_height = getattr(location, "max_height_mm")
    return height <= bay_height and not (length <= bay_width and width <= bay_depth) and width <= bay_width and length <= bay_depth


def pack_packages(
    dimensions: tuple[int, int, int],
    quantity: int,
    location: object,
    occupied: list[dict] | None = None,
) -> list[dict]:
    """Place as many same-sized packages as possible on one shelf surface."""
    length, width, height = dimensions
    bay_width = getattr(location, "width_mm")
    bay_depth = getattr(location, "depth_mm")
    bay_height = getattr(location, "max_height_mm")
    if height > bay_height or quantity <= 0:
        return []
    rectangles = [dict(rectangle) for rectangle in (occupied or [])]
    placed: list[dict] = []
    for _ in range(quantity):
        x_candidates = {0}
        y_candidates = {0}
        for rectangle in rectangles:
            x_candidates.add(rectangle["x_mm"] + rectangle["length_mm"])
            y_candidates.add(rectangle["y_mm"] + rectangle["width_mm"])
        candidates = {(x, y) for x in x_candidates for y in y_candidates}
        candidate = None
        for x, y in sorted(candidates, key=lambda point: (point[1], point[0])):
            for rotated in (False, True):
                package_length, package_width = (width, length) if rotated else (length, width)
                if x + package_length > bay_width or y + package_width > bay_depth:
                    continue
                overlaps = any(
                    x < rectangle["x_mm"] + rectangle["length_mm"]
                    and x + package_length > rectangle["x_mm"]
                    and y < rectangle["y_mm"] + rectangle["width_mm"]
                    and y + package_width > rectangle["y_mm"]
                    for rectangle in rectangles
                )
                if not overlaps:
                    candidate = {
                        "x_mm": x,
                        "y_mm": y,
                        "length_mm": package_length,
                        "width_mm": package_width,
                        "height_mm": height,
                        "rotated": rotated,
                    }
                    break
            if candidate is not None:
                break
        if candidate is None:
            break
        placed.append(candidate)
        rectangles.append(candidate)
    return placed


@dataclass(frozen=True)
class RackTypeConfig:
    title: str
    purpose: str
    width_mm: int
    depth_mm: int
    height_mm: int
    levels: int
    positions_per_level: int = 2


RACK_TYPES: dict[str, RackTypeConfig] = {
    "pallet_high": RackTypeConfig("Высокий паллетный", "Хранение паллетных грузов", 2700, 1100, 6000, 4),
    "pallet_standard": RackTypeConfig("Стандартный паллетный", "Хранение паллет и крупногабаритных товаров", 1800, 1100, 4500, 3),
    "medium_shelving": RackTypeConfig("Среднегрузовой", "Хранение коробок и товаров среднего размера", 1800, 600, 2500, 4),
    "small_parts_shelving": RackTypeConfig("Для мелких товаров", "Хранение мелких деталей и комплектующих", 1200, 450, 2000, 5),
}


def rack_for_position(rack_id: str, position: Point, rack_type: str) -> Rack:
    config = RACK_TYPES[rack_type]
    return Rack(
        id=rack_id,
        rack_type=rack_type,
        position=position,
        width_mm=config.width_mm,
        depth_mm=config.depth_mm,
        height_mm=config.height_mm,
        levels=config.levels,
        positions_per_level=config.positions_per_level,
    )


def demo_racks(points: list[Point]) -> list[Rack]:
    racks: list[Rack] = []
    for index, point in enumerate(sorted(points, key=lambda item: (item[1], item[0])), 1):
        x, y = point
        if y < 4 and x < 6:
            rack_type = "pallet_high"
        elif y < 4:
            rack_type = "pallet_standard"
        elif x < 6:
            rack_type = "medium_shelving"
        else:
            rack_type = "small_parts_shelving"
        racks.append(rack_for_position(f"A-{index:02d}", point, rack_type))
    return racks


def storage_address(rack_id: str, level: int, position: int) -> str:
    return f"{rack_id}-L{level:02d}-P{position:02d}"
