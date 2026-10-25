import unittest
from fastapi.testclient import TestClient
from backend.main import app, simulation
from backend.layout import Layout, from_warehouse

class LayoutTests(unittest.TestCase):
    def setUp(self):
        simulation.custom_layout = None
        simulation.reset()
        self.client = TestClient(app)
        self.layout = self.client.get('/api/layout').json()

    def test_roundtrip_and_reset(self):
        self.layout['cells'][0]['levels'] = 4
        r = self.client.put('/api/layout', json=self.layout)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['warehouse']['orders'], [])
        self.assertEqual(self.client.get('/api/layout').json(), self.layout)
        simulation.reset()
        self.assertEqual(self.client.get('/api/layout').json(), self.layout)

    def test_rack_details_survive_updates_and_can_differ(self):
        racks = [cell for cell in self.layout['cells'] if cell['kind'] == 'rack']
        self.assertGreaterEqual(len(racks), 2)
        first_id, second_id = racks[0]['id'], racks[1]['id']
        racks[0].update(width_mm=3200, depth_mm=1100, height_mm=4000, levels=7)
        racks[1].update(width_mm=1500, depth_mm=600, height_mm=2000, levels=3)
        response = self.client.put('/api/layout', json=self.layout)
        self.assertEqual(response.status_code, 200)
        by_id = {rack['id']: rack for rack in response.json()['warehouse']['racks']}
        self.assertEqual((by_id[first_id]['width_mm'], by_id[first_id]['levels']), (3200, 7))
        self.assertEqual((by_id[second_id]['depth_mm'], by_id[second_id]['height_mm']), (600, 2000))
        simulation.reset()
        self.assertEqual(self.client.get('/api/layout').json(), self.layout)
        self.assertEqual(self.client.get('/api/state').json()['warehouse']['racks'], response.json()['warehouse']['racks'])

    def test_rack_defaults_and_duplicate_ids(self):
        rack = next(cell for cell in self.layout['cells'] if cell['kind'] == 'rack')
        expected = (rack['rack_type'], rack['width_mm'], rack['depth_mm'], rack['height_mm'], rack['levels'])
        for field in ('id', 'rack_type', 'width_mm', 'depth_mm', 'height_mm', 'levels', 'positions_per_level'):
            rack.pop(field)
        simulation.warehouse.inventory.clear()
        response = self.client.put('/api/layout', json=self.layout)
        self.assertEqual(response.status_code, 200)
        restored = next(item for item in response.json()['warehouse']['racks'] if item['position'] == [rack['x'], rack['y']])
        self.assertEqual((restored['rack_type'], restored['width_mm'], restored['depth_mm'], restored['height_mm'], restored['levels']), expected)
        self.assertTrue(restored['id'])
        duplicate = self.client.get('/api/layout').json()
        racks = [cell for cell in duplicate['cells'] if cell['kind'] == 'rack']
        racks[1]['id'] = racks[0]['id']
        self.assertEqual(self.client.put('/api/layout', json=duplicate).status_code, 422)

    def test_rack_catalog_and_storage_addresses_are_stable(self):
        catalog = self.client.get('/api/rack-types').json()
        self.assertEqual(set(catalog), {'pallet_high', 'pallet_standard', 'medium_shelving', 'small_parts_shelving'})
        state = self.client.get('/api/state').json()['warehouse']
        self.assertEqual(len(state['racks']), 16)
        self.assertEqual(len(state['storage_locations']), sum(rack['location_count'] for rack in state['racks']))
        addresses = [location['address'] for location in state['storage_locations']]
        self.assertEqual(len(addresses), len(set(addresses)))
        self.assertTrue(all('-L' in address and '-P' in address for address in addresses))
        initial = {rack['id']: rack['rack_type'] for rack in state['racks']}
        simulation.reset()
        after_reset = {rack['id']: rack['rack_type'] for rack in self.client.get('/api/state').json()['warehouse']['racks']}
        self.assertEqual(initial, after_reset)

    def test_inventory_allocation_split_and_quantity_confirmation(self):
        for order in simulation.warehouse.orders[:2]:
            order.status = 'completed'
        simulation.start()
        order = simulation._get_order('ORD-003')
        allocations = order.allocations
        self.assertEqual([(item.storage_location_id, item.quantity) for item in allocations], [('A-03-L01-P01', 3), ('A-04-L01-P01', 2)])
        self.assertEqual(sum(simulation._get_stock_item(item.stock_item_id).reservations[order.id] for item in allocations), 5)
        robot = simulation._get_robot(order.robot_id)
        simulation.driver_action(robot.id, order.id, 'accept')
        for allocation in allocations:
            while robot.driver_phase != 'confirm_pickup':
                simulation.tick()
            stock = simulation._get_stock_item(allocation.stock_item_id)
            quantity_before = stock.quantity
            simulation.driver_action(robot.id, order.id, 'pickup')
            self.assertEqual(stock.quantity, quantity_before - allocation.quantity)
        while robot.driver_phase != 'confirm_delivery':
            simulation.tick()
        simulation.driver_action(robot.id, order.id, 'deliver')
        self.assertEqual(order.status, 'completed')
        self.assertEqual(order.picked_quantity, 5)
        self.assertEqual(sum(simulation._get_stock_item(item.stock_item_id).quantity for item in allocations), 0)

    def test_shortage_and_cancellation_release_reservations(self):
        insufficient = self.client.post('/api/orders', json={'item': 'Перебор', 'pickup': [3, 1], 'dropoff': [11, 1], 'product_id': 'SKU-001', 'quantity': 99})
        self.assertEqual(insufficient.status_code, 409)
        simulation.start()
        order = simulation._get_order('ORD-001')
        self.assertEqual(order.status, 'assigned')
        stock = simulation._get_stock_item(order.item_id)
        self.assertEqual(stock.reservations[order.id], order.quantity)
        before = stock.quantity
        canceled = self.client.post(f'/api/orders/{order.id}/cancel')
        self.assertEqual(canceled.status_code, 200)
        self.assertEqual(order.status, 'cancelled')
        self.assertNotIn(order.id, stock.reservations)
        self.assertNotIn(order.id, stock.reserved_placements)
        self.assertEqual(stock.quantity, before)

    def test_reject_invalid_atomically(self):
        before = simulation.state()
        for cell in [dict(x=99,y=0,kind='wall'), self.layout['cells'][0]]:
            bad = {**self.layout, 'cells': self.layout['cells'] + [cell]}
            self.assertEqual(self.client.put('/api/layout', json=bad).status_code,422)
            self.assertEqual(simulation.state(),before)

    def test_disconnected_and_inaccessible(self):
        data = dict(version=1,width=5,height=5,cells=[dict(x=0,y=0,kind='robot'),dict(x=4,y=0,kind='pickup'),dict(x=4,y=4,kind='shipping')]+[dict(x=2,y=y,kind='wall') for y in range(5)])
        self.assertFalse(self.client.post('/api/layout/validate',json=data).json()['valid'])

    def test_active_and_paused_tasks_cannot_be_erased(self):
        simulation.start()
        self.assertEqual(self.client.put('/api/layout',json=self.layout).status_code,409)
        simulation.pause()
        self.assertEqual(self.client.put('/api/layout',json=self.layout).status_code,409)

    def test_existing_agents_run_custom_layout(self):
        self.assertEqual(self.client.put('/api/layout',json=self.layout).status_code,200)
        w = simulation.warehouse
        simulation.add_order('Демо', w.pickup_points[0], w.shipping_points[0])
        simulation.start()
        for _ in range(160):
            for r in w.robots:
                action = {'offered':'accept','confirm_pickup':'pickup','confirm_delivery':'deliver'}.get(r.driver_phase)
                if action: simulation.driver_action(r.id,r.order_id,action)
            simulation.tick()
            if w.orders[0].status == 'completed': break
        self.assertEqual(w.orders[0].status,'completed')

    def tearDown(self):
        simulation.custom_layout = None
        simulation.reset()
