"""User-facing task lifecycle and warehouse invariants, without external services."""
import unittest

from backend.simulation import WarehouseSimulation


class DriverWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.sim = WarehouseSimulation()
        self.sim.start()
        self.robot = self.sim.warehouse.robots[0]

    def act(self, action):
        return self.sim.driver_action(self.robot.id, self.robot.order_id, action)

    def reach(self, phase):
        for _ in range(100):
            if self.robot.driver_phase == phase:
                return
            self.sim.tick()
        self.fail(f"Did not reach {phase}: {self.robot}")

    def test_goods_require_confirmation_at_both_ends(self):
        order = self.sim._get_order(self.robot.order_id)
        stock = self.sim._get_stock_item(order.item_id)
        initial_quantity = stock.quantity
        storage_position = stock.position
        start = self.robot.position
        for _ in range(5):
            self.sim.tick()
        self.assertEqual(self.robot.position, start)
        with self.assertRaises(ValueError):
            self.act('deliver')
        self.act('accept')
        with self.assertRaises(ValueError):
            self.act('pickup')
        self.reach('confirm_pickup')
        for _ in range(5):
            self.sim.tick()
        self.assertEqual(stock.status, 'reserved')
        self.act('pickup')
        self.reach('confirm_delivery')
        for _ in range(5):
            self.sim.tick()
        self.assertNotEqual(order.status, 'completed')
        self.act('deliver')
        self.assertEqual(order.status, 'completed')
        self.assertEqual(stock.position, storage_position)
        self.assertEqual(stock.quantity, initial_quantity - order.quantity)
        self.assertIsNone(stock.reserved_by)
        with self.assertRaises(ValueError):
            self.sim.driver_action(self.robot.id, order.id, 'deliver')

    def test_report_targets_own_route_and_preserves_stop(self):
        next_cell = self.robot.route[0]
        self.sim.stop_robot(self.robot.id)
        self.sim.create_congestion(self.robot.id)
        self.assertIn(next_cell, self.sim.zone_agent.blocked_cells)
        self.assertEqual(self.robot.status, 'stopped')
        self.assertNotIn(next_cell, self.robot.route)
        with self.assertRaises(ValueError):
            self.act('accept')
        self.sim.reopen_aisles()
        self.assertEqual(self.robot.status, 'stopped')
        self.assertFalse(self.sim.zone_agent.blocked_cells)

    def test_full_shift_finishes_without_vehicle_overlap(self):
        actions = {'offered': 'accept', 'confirm_pickup': 'pickup', 'confirm_delivery': 'deliver'}
        for _ in range(300):
            for robot in self.sim.warehouse.robots:
                if robot.driver_phase in actions:
                    self.sim.driver_action(robot.id, robot.order_id, actions[robot.driver_phase])
            self.sim.tick()
            positions = [robot.position for robot in self.sim.warehouse.robots]
            self.assertEqual(len(positions), len(set(positions)))
            if all(order.status == 'completed' for order in self.sim.warehouse.orders) and all(robot.driver_phase == 'idle' for robot in self.sim.warehouse.robots):
                break
        else:
            self.fail('Shift did not complete and return to parking')
        self.assertTrue(all(order.picked_quantity == order.quantity for order in self.sim.warehouse.orders))
        self.assertTrue(all(item.quantity >= 0 for item in self.sim.warehouse.inventory))

    def test_no_route_waits_and_reopening_recovers(self):
        self.sim.zone_agent.blocked_cells.update({(0, 0), (0, 2), (1, 1)})
        self.act('accept')
        self.sim.tick()
        self.assertEqual(self.robot.status, 'waiting')
        self.assertEqual(self.robot.position, (0, 1))
        self.sim.reopen_aisles()
        self.reach('confirm_pickup')
        self.assertEqual(self.robot.position, (3, 1))

    def test_stale_task_is_rejected(self):
        with self.assertRaises(ValueError):
            self.sim.driver_action(self.robot.id, 'wrong-task', 'accept')
        self.assertEqual(self.robot.driver_phase, 'offered')


if __name__ == '__main__':
    unittest.main()
