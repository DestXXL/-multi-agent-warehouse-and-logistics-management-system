"""HTTP and WebSocket API for the virtual warehouse operator interface."""

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

from backend.simulation import WarehouseSimulation
from backend.layout import Layout, from_warehouse
from backend.rack_types import RACK_TYPES, pack_packages


simulation = WarehouseSimulation()
connections: set[WebSocket] = set()


class CreateOrderRequest(BaseModel):
    item: str = Field(min_length=1, max_length=80)
    pickup: tuple[int, int]
    dropoff: tuple[int, int]
    product_id: str | None = Field(default=None, min_length=1, max_length=80)
    quantity: int = Field(default=1, ge=1, le=1_000_000)
    length_mm: int | None = Field(default=None, ge=1, le=20_000)
    width_mm: int | None = Field(default=None, ge=1, le=10_000)
    height_mm: int | None = Field(default=None, ge=1, le=15_000)

    @model_validator(mode="after")
    def dimensions_are_complete(self) -> "CreateOrderRequest":
        supplied = (self.length_mm, self.width_mm, self.height_mm)
        if any(value is not None for value in supplied) and any(value is None for value in supplied):
            raise ValueError("Укажите длину, ширину и высоту вместе, в миллиметрах")
        return self


class DriverActionRequest(BaseModel):
    order_id: str
    action: str


class ResizeProductRequest(BaseModel):
    length_mm: int = Field(ge=1, le=20_000, strict=True)
    width_mm: int = Field(ge=1, le=10_000, strict=True)
    height_mm: int = Field(ge=1, le=15_000, strict=True)


async def simulation_loop() -> None:
    while True:
        if simulation.running:
            state = simulation.tick()
            await broadcast(state)
        await asyncio.sleep(simulation.TICK_SECONDS)


async def broadcast(state: dict) -> None:
    stale: list[WebSocket] = []
    for websocket in tuple(connections):
        try:
            await websocket.send_json(state)
        except Exception:
            stale.append(websocket)
    for websocket in stale:
        connections.discard(websocket)


async def publish_state() -> dict:
    state = simulation.state()
    await broadcast(state)
    return state


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(simulation_loop())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="Warehouse Control API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/state")
async def get_state() -> dict:
    return simulation.state()


@app.get("/api/rack-types")
async def get_rack_types() -> dict:
    return {key: {"key": key, **config.__dict__} for key, config in RACK_TYPES.items()}


@app.post("/api/simulation/start")
async def start_simulation() -> dict:
    simulation.start()
    return await publish_state()


@app.post("/api/simulation/pause")
async def pause_simulation() -> dict:
    simulation.pause()
    return await publish_state()


@app.post("/api/simulation/reset")
async def reset_simulation() -> dict:
    simulation.reset()
    return await publish_state()


@app.post("/api/simulation/congestion")
async def create_congestion() -> dict:
    try:
        state = simulation.create_congestion()
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await broadcast(state)
    return state


@app.post("/api/robots/{robot_id}/driver-action")
async def driver_action(robot_id: str, request: DriverActionRequest) -> dict:
    try:
        state = simulation.driver_action(robot_id, request.order_id, request.action)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await broadcast(state)
    return state


@app.post("/api/robots/{robot_id}/obstacle")
async def report_obstacle(robot_id: str) -> dict:
    try:
        state = simulation.create_congestion(robot_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await broadcast(state)
    return state


@app.post("/api/aisles/reopen")
async def reopen_aisles() -> dict:
    state = simulation.reopen_aisles()
    await broadcast(state)
    return state


@app.post("/api/orders")
async def create_order(request: CreateOrderRequest) -> dict:
    for point in (request.pickup, request.dropoff):
        x, y = point
        if not (0 <= x < simulation.warehouse.width and 0 <= y < simulation.warehouse.height):
            raise HTTPException(status_code=422, detail=f"Точка {point} находится вне карты склада")
        if point in simulation.warehouse.obstacles:
            raise HTTPException(status_code=422, detail=f"Точка {point} занята стеллажом")
    try:
        dimensions = None if request.length_mm is None else (request.length_mm, request.width_mm, request.height_mm)
        state = simulation.add_order(request.item, request.pickup, request.dropoff, request.product_id, request.quantity, dimensions)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await broadcast(state)
    return state


@app.post("/api/orders/{order_id}/cancel")
async def cancel_order(order_id: str) -> dict:
    try:
        state = simulation.cancel_order(order_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await broadcast(state)
    return state


@app.put("/api/inventory/{item_id}/dimensions")
async def resize_inventory_item(item_id: str, request: ResizeProductRequest) -> dict:
    try:
        state = simulation.resize_product(item_id, (request.length_mm, request.width_mm, request.height_mm))
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await broadcast(state)
    return state


@app.post("/api/robots/{robot_id}/stop")
async def stop_robot(robot_id: str) -> dict:
    try:
        state = simulation.stop_robot(robot_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    await broadcast(state)
    return state


@app.post("/api/robots/{robot_id}/resume")
async def resume_robot(robot_id: str) -> dict:
    try:
        state = simulation.resume_robot(robot_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    await broadcast(state)
    return state


@app.websocket("/ws/state")
async def state_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    connections.add(websocket)
    await websocket.send_json(simulation.state())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connections.discard(websocket)


# Layout edits are atomic and only allowed before any simulation tasks execute.
@app.get("/api/layout")
async def get_layout() -> dict:
    return (simulation.custom_layout or from_warehouse(simulation.warehouse)).model_dump(exclude_none=True)

@app.post("/api/layout/validate")
async def validate_layout(layout: Layout) -> dict:
    errors = layout.errors()
    return {"valid": not errors, "errors": errors}

@app.put("/api/layout")
async def apply_layout(layout: Layout) -> dict:
    errors = layout.errors()
    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors))
    if simulation.running or simulation.tick_count or any(o.status != "pending" for o in simulation.warehouse.orders):
        raise HTTPException(status_code=409, detail="Сначала завершите работу и сбросьте симуляцию. Пауза не разрешает изменение макета.")
    replacement = layout.warehouse()
    replacement_locations = {location.id for location in replacement.storage_locations}
    occupied_items = [item for item in simulation.warehouse.inventory if item.quantity > 0 or item.reservations]
    missing_locations = sorted({item.location_id or "(без адреса)" for item in occupied_items if item.location_id not in replacement_locations})
    if missing_locations:
        raise HTTPException(status_code=409, detail=f"Нельзя удалить занятые места хранения: {', '.join(missing_locations)}")
    proposed_placements = {}
    items_by_location: dict[str, list] = {}
    for item in occupied_items:
        items_by_location.setdefault(item.location_id, []).append(item)
    replacement_by_id = {location.id: location for location in replacement.storage_locations}
    for location_id, items in items_by_location.items():
        location = replacement_by_id[location_id]
        occupied_rectangles = []
        for item in items:
            placements = pack_packages(
                (item.length_mm, item.width_mm, item.height_mm),
                item.quantity,
                location,
                occupied_rectangles,
            )
            if len(placements) != item.quantity:
                raise HTTPException(status_code=409, detail=f"Груз {item.name} размером {item.length_mm} × {item.width_mm} × {item.height_mm} мм не помещается полностью в {location.address}")
            proposed_placements[item.id] = placements
            occupied_rectangles.extend(placements)
    for item in simulation.warehouse.inventory:
        if item.location_id in replacement_locations:
            location = replacement_by_id[item.location_id]
            rack = next(rack for rack in replacement.racks if rack.id == location.rack_id)
            item.position = rack.service_point or rack.position
            item.placement_x_mm = location.x_mm
            item.placement_y_mm = location.y_mm
            if item.id in proposed_placements:
                item.unit_placements = proposed_placements[item.id]
                item.placement_x_mm = item.unit_placements[0]["x_mm"]
                item.placement_y_mm = item.unit_placements[0]["y_mm"]
                item.rotated = item.unit_placements[0]["rotated"]
    simulation.custom_layout = layout.model_copy(deep=True)
    simulation.reset()
    simulation._event("Применён макет конструктора. Добавьте заказы для точек забора и отгрузки.", "operator")
    return await publish_state()
