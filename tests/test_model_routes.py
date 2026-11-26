import unittest
from unittest.mock import AsyncMock, patch

from backend.harness import Decision
from backend.route_advisor import plan_routes
from backend.simulation import WarehouseSimulation


class ModelRoutes(unittest.IsolatedAsyncioTestCase):
    async def test_unavailable_model_uses_valid_route(self):
        sim = WarehouseSimulation()
        sim.dispatch_mode = 'model'
        sim.start()
        robot = next(r for r in sim.warehouse.robots if r.order_id)
        sim.driver_action(robot.id, robot.order_id, 'accept')
        with patch('backend.route_advisor.consult', AsyncMock(return_value=None)):
            self.assertTrue(await plan_routes(sim, object()))
        self.assertTrue(sim.approved_route(robot))
        self.assertGreater(sim.metrics['fallbacks'], 0)

    async def test_wait_reject_accept_and_stop_at_closure(self):
        sim = WarehouseSimulation()
        sim.dispatch_mode = "model"
        sim.start()
        robot = next(r for r in sim.warehouse.robots if r.order_id)
        sim.driver_action(robot.id, robot.order_id, "accept")
        start = robot.position
        for _ in range(4):
            sim.tick(assign_orders=False)
        self.assertEqual(robot.position, start)
        self.assertFalse(robot.route)

        async def answer(client, simulation, role, data):
            return Decision(data["connected_sequences"][0], "Путь к цели", "test")

        with patch("backend.route_advisor.consult", AsyncMock(return_value=Decision(["invalid"], "Ошибка", "test"))):
            self.assertFalse(await plan_routes(sim, object()))
        with patch("backend.route_advisor.consult", side_effect=answer):
            self.assertTrue(await plan_routes(sim, object()))
        path = robot.route.copy()
        self.assertTrue(path)
        for _ in range(5):
            sim.tick(assign_orders=False)
            if robot.position != start:
                break
        self.assertEqual(robot.position, path[0])
        if robot.route:
            sim.zone_agent.blocked_cells.add(robot.route[0])
            sim.tick(assign_orders=False)
            self.assertEqual(robot.position, path[0])
            self.assertIsNone(sim.approved_route(robot))
