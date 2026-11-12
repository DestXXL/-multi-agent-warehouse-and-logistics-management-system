"""Rack-side pickup, orientation and cell occupancy across full warehouse runs."""
import unittest

from backend.layout import Layout, from_warehouse
from backend.models import Robot, StockItem, Warehouse
from backend.simulation import WarehouseSimulation


class ForkliftTests(unittest.TestCase):
    def isolated_rack(self):
        sim = WarehouseSimulation()
        layout = Layout.model_validate(dict(version=1, width=8, height=7, cells=[
            dict(x=0, y=0, kind='robot'), dict(x=0, y=6, kind='robot'),
            dict(x=7, y=6, kind='shipping'),
            dict(x=4, y=3, kind='rack', id='TEST-01'),
        ]))
        sim.custom_layout = layout
        sim.reset()
        location = sim.warehouse.storage_locations[0]
        sim.warehouse.inventory = [StockItem('TEST', 'Test', (4, 3), 'small', product_id='TEST',
            location_id=location.id, quantity=2, length_mm=50, width_mm=50, height_mm=50)]
        sim._initialize_stock_placements()
        sim.add_order('Test', (0, 0), (7, 6), 'TEST', 1)
        return sim

    def assert_step(self, sim, before):
        robots = sim.warehouse.robots
        self.assertEqual(len({r.position for r in robots}), len(robots))
        blocked = set(sim.warehouse.obstacles) | {r.position for r in sim.warehouse.racks}
        for robot in robots:
            old_position, old_heading = before[robot.id]
            self.assertNotIn(robot.position, blocked)
            if robot.position != old_position:
                self.assertEqual(robot.motion, 'moving')
                self.assertEqual(robot.heading, old_heading)
                self.assertEqual(robot.heading, sim._heading(old_position, robot.position))
                self.assertNotIn(robot.position, {p for key, (p, _) in before.items() if key != robot.id})
            if robot.heading != old_heading:
                self.assertEqual(robot.position, old_position)
                self.assertIn((robot.heading - old_heading) % 360, (90, 270))

    def tick(self, sim):
        before = {r.id: (r.position, r.heading) for r in sim.warehouse.robots}
        sim.tick()
        self.assert_step(sim, before)

    def run_orders(self, sim, limit=400):
        sim.start()
        for _ in range(limit):
            for robot in sim.warehouse.robots:
                action = {'offered': 'accept', 'confirm_pickup': 'pickup', 'confirm_delivery': 'deliver'}.get(robot.driver_phase)
                if action:
                    if action == 'pickup':
                        order = sim._get_order(robot.order_id)
                        self.assertTrue(sim._at_pickup(robot, order))
                        rack = sim._pickup_rack(order)
                        self.assertEqual(robot.position[0], rack.position[0])
                        self.assertEqual(abs(robot.position[1] - rack.position[1]), 1)
                        stock = sim._get_stock_item(sim._current_allocation(order).stock_item_id)
                        before = stock.quantity
                        count = sim._current_allocation(order).quantity
                        sim.driver_action(robot.id, order.id, action)
                        self.assertEqual(stock.quantity, before - count)
                        self.assertEqual(len(stock.unit_placements), stock.quantity)
                        self.assertTrue(robot.carrying_item)
                        continue
                    sim.driver_action(robot.id, robot.order_id, action)
            self.tick(sim)
            if all(o.status == 'completed' for o in sim.warehouse.orders) and all(r.driver_phase == 'idle' for r in sim.warehouse.robots):
                return
        self.fail('Orders did not complete')

    def test_all_demo_racks_and_upper_levels_support_pickup_and_delivery(self):
        for index in range(16):
            with self.subTest(rack=index):
                sim = WarehouseSimulation()
                sim.warehouse.orders.clear()
                sim.warehouse.inventory.clear()
                rack = sim.warehouse.racks[index]
                location = next(loc for loc in reversed(sim.warehouse.storage_locations) if loc.rack_id == rack.id)
                stock = StockItem('TEST', 'Test', rack.position, 'small', product_id='TEST', location_id=location.id, quantity=2, length_mm=50, width_mm=50, height_mm=50)
                sim.warehouse.inventory.append(stock)
                sim._initialize_stock_placements()
                sim.add_order('Test', (0, 0), sim.warehouse.shipping_points[0], 'TEST', 1)
                self.run_orders(sim)
                self.assertEqual(stock.quantity, 1)
                self.assertEqual(sim.warehouse.orders[0].picked_quantity, 1)
                self.assertTrue(all(not r.carrying_item for r in sim.warehouse.robots))

    def test_straight_steps_continue_until_turn_or_action(self):
        sim = WarehouseSimulation()
        sim.warehouse.orders.clear()
        robot = Robot('TEST', (0, 0), home=(3, 0), driver_phase='returning')
        sim.warehouse.robots = [robot]
        sim.start()
        for x in (1, 2, 3):
            self.tick(sim)
            self.assertEqual(robot.position, (x, 0))
            self.assertEqual(robot.motion, 'moving')
            self.assertEqual(robot.heading, 0)
        self.tick(sim)
        self.assertEqual(robot.position, (3, 0))
        self.assertEqual(robot.driver_phase, 'idle')
        self.assertEqual(robot.motion, 'idle')

    def test_multirobot_multiaddress_shift(self):
        self.run_orders(WarehouseSimulation())

    def test_all_four_directions_require_turning_before_translation(self):
        sim = WarehouseSimulation()
        robot = Robot('TEST', (1, 1))
        for goal in [(1, 0), (0, 0), (0, 1), (1, 1)]:
            position = robot.position
            for _ in range(3):
                old_heading = robot.heading
                moved = sim._advance(robot, [goal], set())
                if moved:
                    self.assertEqual(old_heading, robot.heading)
                    self.assertEqual(robot.heading, sim._heading(position, goal))
                    break
                self.assertEqual(robot.position, position)
            else:
                self.fail('Could not turn and move')

    def test_other_side_is_selected_when_access_is_closed_or_occupied(self):
        sim = self.isolated_rack()
        sim.start()
        robot = sim._get_robot(sim.warehouse.orders[0].robot_id)
        order = sim.warehouse.orders[0]
        old_side = order.pickup
        sim.zone_agent.blocked_cells.add(old_side)
        sim._refresh_route(robot)
        self.assertNotEqual(order.pickup, old_side)
        alternate = order.pickup
        sim.zone_agent.clear()
        other = next(r for r in sim.warehouse.robots if r.id != robot.id)
        other.position = alternate
        sim._refresh_route(robot)
        self.assertNotEqual(order.pickup, alternate)
        self.assertTrue(robot.route)

    def test_closed_shelf_faces_never_fall_back_to_rack_ends(self):
        sim = self.isolated_rack()
        sim.start()
        order = sim.warehouse.orders[0]
        robot = sim._get_robot(order.robot_id)
        sim.driver_action(robot.id, order.id, 'accept')
        sim.zone_agent.blocked_cells.update({(4, 2), (4, 4)})
        start = robot.position
        for _ in range(5):
            self.tick(sim)
            self.assertEqual(robot.position, start)
            self.assertEqual(robot.status, 'waiting')
            self.assertEqual(order.picked_quantity, 0)
        self.assertEqual(sim._access_points(sim.warehouse.racks[0]), [])
        sim.reopen_aisles()
        self.run_orders(sim)

    def test_manual_pickup_at_rack_end_is_rejected(self):
        sim = self.isolated_rack()
        sim.start()
        order = sim.warehouse.orders[0]
        robot = sim._get_robot(order.robot_id)
        robot.driver_phase = 'confirm_pickup'
        robot.motion = 'idle'
        for position, heading in (((3, 3), 0), ((5, 3), 180)):
            robot.position = order.pickup = position
            robot.heading = heading
            with self.assertRaises(ValueError):
                sim.driver_action(robot.id, order.id, 'pickup')
            self.assertEqual(order.picked_quantity, 0)
            self.assertFalse(robot.carrying_item)
        self.assertEqual(sim.warehouse.inventory[0].quantity, 2)

    def test_layout_with_only_end_access_is_invalid(self):
        layout = from_warehouse(self.isolated_rack().warehouse).model_dump()
        layout['cells'].extend([dict(x=4, y=y, kind='wall') for y in (2, 4)])
        self.assertTrue(any('полок' in error for error in Layout.model_validate(layout).errors()))

    def test_no_access_waits_without_teleport_and_recovers(self):
        sim = WarehouseSimulation()
        sim.warehouse.orders = sim.warehouse.orders[:1]
        sim.start()
        robot = sim._get_robot(sim.warehouse.orders[0].robot_id)
        order = sim.warehouse.orders[0]
        sim.driver_action(robot.id, order.id, 'accept')
        start = robot.position
        rack = sim._pickup_rack(order)
        sim.zone_agent.blocked_cells.update(sim._access_points(rack))
        for _ in range(5):
            self.tick(sim)
            self.assertEqual(robot.position, start)
            self.assertEqual(order.picked_quantity, 0)
        sim.reopen_aisles()
        self.run_orders(sim)

    def test_pickup_rejects_wrong_fork_orientation(self):
        sim = WarehouseSimulation()
        sim.warehouse.orders = sim.warehouse.orders[:1]
        sim.start()
        robot = sim._get_robot(sim.warehouse.orders[0].robot_id)
        sim.driver_action(robot.id, robot.order_id, 'accept')
        for _ in range(100):
            self.tick(sim)
            if robot.driver_phase == 'confirm_pickup':
                break
        self.assertEqual(robot.driver_phase, 'confirm_pickup')
        robot.heading = (robot.heading + 180) % 360
        with self.assertRaises(ValueError):
            sim.driver_action(robot.id, robot.order_id, 'pickup')
        self.assertFalse(robot.carrying_item)

    def test_coordinated_turn_does_not_consume_path_cell(self):
        from backend.dispatch import coordination_step
        sim = WarehouseSimulation()
        robot = sim.warehouse.robots[0]
        robot.driver_phase = 'returning'
        robot.home = (1, 1)
        robot.heading = 180
        sim.coordination = [(robot.id, robot.home, [(1, 1)], True)]
        sim.running = True
        self.tick(sim)
        self.assertEqual(robot.position, (0, 1))
        self.assertEqual(coordination_step(sim), (robot.id, [(1, 1)]))
        self.tick(sim)
        self.assertEqual(robot.position, (0, 1))
        self.tick(sim)
        self.assertEqual(robot.position, (1, 1))

    def test_legacy_pickup_zones_discarded_and_not_required(self):
        sim = WarehouseSimulation()
        self.assertEqual(sim.state()['warehouse']['pickup_points'], [])
        layout = from_warehouse(sim.warehouse).model_dump()
        layout['cells'].append(dict(x=2, y=7, kind='pickup'))
        restored = Layout.model_validate(layout)
        self.assertFalse(restored.errors())
        self.assertFalse(any(cell.kind == 'pickup' for cell in restored.cells))
        self.assertEqual(restored.warehouse().pickup_points, [])
        snapshot = sim.warehouse.to_dict()
        snapshot['pickup_points'] = [[2, 7]]
        self.assertEqual(Warehouse.from_dict(snapshot).pickup_points, [])

    def test_three_forklifts_on_custom_layout_without_pickup_zones(self):
        sim = WarehouseSimulation()
        layout = Layout.model_validate(dict(version=1, width=9, height=7, cells=[
            dict(x=0, y=y, kind='robot') for y in (0, 3, 6)
        ] + [dict(x=8, y=3, kind='shipping')] + [
            dict(x=4, y=y, kind='rack', id=f'T-{y}', width_mm=1200 + y * 250,
                 depth_mm=500 + y * 50, height_mm=3000, levels=y+1, positions_per_level=3)
            for y in (1, 3, 5)
        ]))
        self.assertFalse(layout.errors())
        sim.custom_layout = layout
        sim.reset()
        sim.warehouse.inventory.clear()
        for rack in sim.warehouse.racks:
            location = next(loc for loc in reversed(sim.warehouse.storage_locations) if loc.rack_id == rack.id)
            sim.warehouse.inventory.append(StockItem(rack.id, rack.id, rack.position, 'small',
                product_id=rack.id, location_id=location.id, quantity=2,
                length_mm=50, width_mm=50, height_mm=50))
        sim._initialize_stock_placements()
        for rack in sim.warehouse.racks:
            sim.add_order(rack.id, (0, 0), (8, 3), rack.id, 1)
        sim.start()
        self.assertEqual(sum(r.order_id is not None for r in sim.warehouse.robots), 3)
        self.run_orders(sim)

    def test_api_order_does_not_require_pickup_zone(self):
        from fastapi.testclient import TestClient
        from backend.main import app
        from unittest.mock import patch
        with patch('backend.main.simulation', WarehouseSimulation()):
            response = TestClient(app).post('/api/orders', json={'item': 'Test', 'dropoff': [11, 1], 'quantity': 1, 'length_mm': 50, 'width_mm': 50, 'height_mm': 50})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['warehouse']['pickup_points'], [])
