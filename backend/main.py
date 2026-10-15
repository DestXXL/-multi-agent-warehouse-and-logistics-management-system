"""HTTP and WebSocket API for the virtual warehouse operator interface."""

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.simulation import WarehouseSimulation


simulation = WarehouseSimulation()
connections: set[WebSocket] = set()


class CreateOrderRequest(BaseModel):
    item: str = Field(min_length=1, max_length=80)
    pickup: tuple[int, int]
    dropoff: tuple[int, int]


class DriverActionRequest(BaseModel):
    order_id: str
    action: str


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
    state = simulation.add_order(request.item, request.pickup, request.dropoff)
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
