import unittest
from unittest.mock import AsyncMock, patch

from backend.harness import Decision, harness_for
from backend.route_advisor import plan_routes
from backend.simulation import WarehouseSimulation


class ModelRoutes(unittest.IsolatedAsyncioTestCase):
    async def test_unambiguous_route_is_approved_without_model(self):
        sim = WarehouseSimulation()
        sim.dispatch_mode = 'model'
        sim.start()
        robot = next(r for r in sim.warehouse.robots if r.order_id)
        sim.driver_action(robot.id, robot.order_id, 'accept')
        with patch('backend.route_advisor.consult', AsyncMock(return_value=None)) as consult:
            self.assertTrue(await plan_routes(sim, object()))
        consult.assert_not_awaited()
        self.assertTrue(sim.approved_route(robot))
        self.assertEqual(sim.metrics['fallbacks'], 0)

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

        self.assertTrue(await plan_routes(sim, None))
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

    async def test_tradeoff_uses_route_id_and_records_blocked_choice(self):
        sim = WarehouseSimulation()
        sim.dispatch_mode = "model"
        sim.start(assign_orders=False)
        robot = sim.warehouse.robots[0]
        robot.position = (0, 0)
        short = [(1, 0), (1, 1), (2, 1), (2, 2)]
        straight = [(0, 1), (0, 2), (0, 3), (1, 3), (2, 3), (2, 2)]
        harness = harness_for(sim)
        harness.history.append({"id": "test"})

        async def answer(client, simulation, role, data, **kwargs):
            self.assertEqual(data["options"], {"route-1": {"cells": 4, "turns": 3},
                                              "route-2": {"cells": 6, "turns": 2}})
            sim.zone_agent.blocked_cells.add((0, 1))
            return Decision(["route-2"], "Меньше поворотов", "test")

        with (patch.object(sim, "route_key", side_effect=lambda target: (None, "returning", (2, 2) if target is robot else None)),
              patch.object(sim, "_plan_route", side_effect=[short, straight]),
              patch("backend.route_advisor.consult", side_effect=answer)):
            self.assertTrue(await plan_routes(sim, object()))
        self.assertEqual(robot.route, short)
        self.assertIn("клетка (0, 1)", harness.history[0]["outcome"])
        self.assertEqual(sim.metrics["fallbacks"], 1)
