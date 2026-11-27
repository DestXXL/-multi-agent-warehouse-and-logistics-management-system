"""Build a pick shift with parallel rack rows, cross aisles and outbound docks."""
import random

from backend.layout import Cell, Layout
from backend.models import Order, StockItem

PRODUCTS = (
    "Комплект уплотнений", "Фильтры воздушные", "Лента упаковочная",
    "Перчатки рабочие", "Кабельные стяжки", "Крепёж оцинкованный",
    "Маркировочные этикетки", "Соединители кабельные", "Втулки монтажные",
)


def generate_shift(rng=None):
    rng = rng or random.SystemRandom()
    bays = rng.randint(2, 4)
    rows = rng.randint(2, 3)
    width, height = bays * 2 + 6, rows * 4 + 1
    cells = []
    parking, shipping = rng.choice(((0, width - 1), (width - 1, 0)))
    for row in range(rows):
        y = row * 4 + 1
        rack_type = rng.choice(("pallet_standard", "medium_shelving"))
        for bay in range(bays * 2):
            x = 2 + bay + (2 if bay >= bays else 0)
            for side in range(2):
                aisle = chr(65 + row * 2 + side)
                cells.append(Cell(x=x, y=y + side, kind="rack", id=f"{aisle}-{bay + 1:02d}", rack_type=rack_type))
        cells.extend((Cell(x=parking, y=y, kind="robot"), Cell(x=shipping, y=y, kind="shipping")))

    # A perimeter loop serves every pick aisle. Leave the four junctions
    # unmarked so a truck can turn between a trunk and a cross aisle.
    for x in range(2, width - 2):
        cells.extend((Cell(x=x, y=0, kind="east"), Cell(x=x, y=height - 1, kind="west")))
    for y in range(1, height - 1):
        cells.extend((Cell(x=1, y=y, kind="north"), Cell(x=width - 2, y=y, kind="south")))
    # Each pair of rack faces opens on a through aisle. Alternating directions
    # lets a vehicle enter from one trunk and return via the other.
    for row in range(rows):
        for x in range(2, width - 2):
            cells.append(Cell(x=x, y=row * 4 + 3, kind="west"))
            if row:
                cells.append(Cell(x=x, y=row * 4, kind="east"))

    layout = Layout(width=width, height=height, cells=cells)
    warehouse = layout.warehouse()
    count = rng.randint(5, min(len(PRODUCTS), len(warehouse.racks)))
    products = rng.sample(PRODUCTS, count)
    for index, rack in enumerate(rng.sample(warehouse.racks, count), 1):
        location = rng.choice([loc for loc in warehouse.storage_locations if loc.rack_id == rack.id])
        sku = f"SKU-{index:03d}"
        name = products[index - 1]
        quantity = rng.randint(3, 6)
        stock = StockItem(sku, name, rack.position, "small", product_id=sku,
                          location_id=location.id, quantity=quantity, length_mm=160, width_mm=120, height_mm=90)
        warehouse.inventory.append(stock)
        warehouse.orders.append(Order(f"ORD-{index:03d}", name, rack.position, rng.choice(warehouse.shipping_points),
                                      item_id=sku, product_id=sku, priority=rng.randint(1, 3), quantity=rng.randint(1, quantity)))
    return layout, warehouse
