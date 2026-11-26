import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from backend.models import Robot
from backend import dispatch
from backend.planning import planning_pass
from backend.simulation import WarehouseSimulation


class QueueRefillTests(unittest.TestCase):
    def test_partial_model_plan_fills_remaining_free_robots(self):
        sim = WarehouseSimulation()
        sim.dispatch_mode = 'model'
        sim.start(assign_orders=False)

        async def choose_one(client, current, role, payload):
            plan = next(key for key, rows in payload['plans'].items() if len(rows) == 1)
            return [plan], 'Одно назначение'

        batches = dispatch.compatible_batches
        def single_options(proposal):
            return {key: rows[:1] for key, rows in batches(proposal).items()}

        with patch('backend.planning.consult', side_effect=choose_one), patch('backend.planning.dispatch.compatible_batches', side_effect=single_options):
            asyncio.run(planning_pass(sim, object(), plan_motion=False))
        self.assertEqual(sum(r.order_id is not None for r in sim.warehouse.robots), 2)
        self.assertEqual(len({r.order_id for r in sim.warehouse.robots}), 2)

    def test_manager_timeout_uses_rules_without_waiting_for_routes(self):
        sim = WarehouseSimulation()
        sim.dispatch_mode = 'model'
        sim.start(assign_orders=False)
        with patch('backend.planning.consult', new=AsyncMock(side_effect=TimeoutError)), patch('backend.planning.plan_routes', new=AsyncMock()) as routes:
            asyncio.run(planning_pass(sim, object(), plan_motion=False))
        self.assertEqual(sum(r.order_id is not None for r in sim.warehouse.robots), 2)
        routes.assert_not_awaited()

    def test_returned_robot_gets_order_in_same_tick(self):
        sim = WarehouseSimulation()
        robot = sim.warehouse.robots[0]
        sim.warehouse.robots = [robot]
        robot.driver_phase = 'returning'
        robot.position = robot.home
        sim.start(assign_orders=False)
        sim.tick()
        self.assertEqual(robot.driver_phase, 'offered')
        self.assertIsNotNone(robot.order_id)


if __name__ == '__main__':
    unittest.main()
