"""HTTP and WebSocket API for the virtual warehouse operator interface."""

import asyncio
import os
from typing import Literal

import httpx
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

from backend import dispatch
from backend.llm import consult
from backend.planning import compare_shift, plan_zone, planning_pass
from backend.simulation import WarehouseSimulation
from backend.layout import Layout, from_warehouse
from backend.rack_types import RACK_TYPES, generated_cargo_dimensions, pack_packages


simulation = WarehouseSimulation()
kodikrouter_key = os.getenv("KODIKROUTER_API_KEY", "").strip()
simulation.model_available = bool(kodikrouter_key)
simulation.dispatch_mode = "model" if kodikrouter_key else "rules"
connections: set[WebSocket] = set()
comparison_lock = asyncio.Lock()


def model_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(headers={"Authorization": f"Bearer {kodikrouter_key}"})


class CreateOrderRequest(BaseModel):
    item: str = Field(min_length=1, max_length=80)
    pickup: tuple[int, int]
    dropoff: tuple[int, int]
    product_id: str | None = Field(default=None, min_length=1, max_length=80)
    quantity: int = Field(default=1, ge=1, le=1_000_000)
    length_mm: int | None = Field(default=None, ge=1, le=20_000)
    width_mm: int | None = Field(default=None, ge=1, le=10_000)
    height_mm: int | None = Field(default=None, ge=1, le=15_000)

    priority: int = Field(default=1, ge=1, le=10)
    due_in_ticks: int | None = Field(default=None, ge=1, le=100_000)

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


class DispatchModeRequest(BaseModel):
    mode: Literal["rules", "model"]


class DispatchQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    target: str | None = Field(default=None, max_length=80)
    closure: tuple[int, int] | None = None


async def simulation_loop() -> None:
    while True:
        if simulation.running:
            state = simulation.tick(assign_orders=simulation.dispatch_mode == "rules")
            if simulation.dispatch_mode == "rules" and await plan_zone(simulation, None):
                state = simulation.state()
            await broadcast(state)
        await asyncio.sleep(simulation.TICK_SECONDS)


async def assignment_loop() -> None:
    async with model_client() as client:
        while True:
            if simulation.dispatch_mode == "model" and await planning_pass(simulation, client):
                await publish_state()
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
    tasks = [asyncio.create_task(simulation_loop())]
    if kodikrouter_key:
        tasks.append(asyncio.create_task(assignment_loop()))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
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


@app.post("/api/dispatch/mode")
async def change_mode(request: DispatchModeRequest) -> dict:
    if request.mode == "model" and not simulation.model_available:
        raise HTTPException(status_code=409, detail="Укажите ключ KodikRouter при запуске backend.")
    if request.mode != simulation.dispatch_mode:
        simulation.dispatch_mode = request.mode
        simulation._event("Режим планирования: " + ("модель." if request.mode == "model" else "правила."), "operator")
    return await publish_state()


@app.post("/api/dispatch/ask")
async def ask_dispatch(request: DispatchQuestion) -> dict:
    facts = dispatch.operator_facts(simulation, request.target, request.closure)
    revision = simulation.revision
    tick = simulation.tick_count
    answer = None
    if simulation.dispatch_mode == "model" and simulation.model_available:
        role = "robot" if any(robot.id == request.target for robot in simulation.warehouse.robots) else "operator"
        async with model_client() as client:
            result = await consult(client, simulation, role, {
                "question": request.question, "facts": facts[:24],
                "tick": tick, "closed_cells": sorted(simulation.zone_agent.blocked_cells)[:20],
                "recent_events": [event["message"] for event in simulation.events if not request.target
                                  or request.target in (event.get("robot_id"), event.get("order_id"))][:5],
            })
        if result and not result[0]:
            answer = result[1]
    return {"answer": answer, "facts": facts, "tick": tick, "revision": revision}


@app.post("/api/dispatch/compare")
async def compare_dispatch() -> dict:
    if not simulation.model_available:
        raise HTTPException(status_code=409, detail="Для сравнения нужен ключ KodikRouter.")
    if comparison_lock.locked():
        raise HTTPException(status_code=409, detail="Сравнение уже запущено.")
    async with comparison_lock, model_client() as client:
        rules, model = await asyncio.gather(compare_shift(None, "rules"), compare_shift(client, "model"))
    return {"rules": rules, "model": model}


@app.get("/api/rack-types")
async def get_rack_types() -> dict:
    return {key: {"key": key, **config.__dict__} for key, config in RACK_TYPES.items()}


@app.post("/api/simulation/start")
async def start_simulation() -> dict:
    simulation.start(assign_orders=simulation.dispatch_mode == "rules")
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
        storage_plan = None
        storage_decision = None
        if request.product_id is None and simulation.dispatch_mode == "model":
            actual_dimensions = dimensions or generated_cargo_dimensions(simulation.next_order_number)
            proposal = dispatch.storage_options(simulation, actual_dimensions, request.quantity, request.dropoff)
            if len(proposal.options) == 1:
                key, storage_plan = next(iter(proposal.options.items()))
                storage_decision = ([key], "rules", "Сервер нашёл один допустимый вариант размещения.")
            elif len(proposal.options) > 1:
                async with model_client() as client:
                    # Only ranking facts are sent, not order names or customer data.
                    shortlist = {key: rows[:12] for key, rows in proposal.facts.items()}
                    result = await consult(client, simulation, "storage", {
                        "revision": proposal.revision, "options": shortlist,
                        "quantity": request.quantity, "dimensions_mm": actual_dimensions,
                    })
                if proposal.revision != simulation.revision or simulation.dispatch_mode != "model":
                    raise HTTPException(status_code=409, detail="Состояние склада изменилось. Повторите создание заказа.")
                if result and len(result[0]) == 1:
                    storage_plan = proposal.options.get(result[0][0])
                if storage_plan is None:
                    simulation.metrics["fallbacks"] += 1
                    storage_decision = ([], "fallback", "Модель не выбрала допустимое размещение. Применены правила.")
                else:
                    storage_decision = (result[0], "model", f"ИИ выбрал {result[0][0]}. Данные о расстоянии, запасе и прошлых отборах рассчитаны сервером.")
        state = simulation.add_order(
            request.item, request.pickup, request.dropoff, request.product_id, request.quantity, dimensions,
            priority=request.priority, due_in_ticks=request.due_in_ticks, storage_plan=storage_plan,
        )
        if storage_decision:
            dispatch.record(simulation, proposal, *storage_decision)
            state = simulation.state()
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
