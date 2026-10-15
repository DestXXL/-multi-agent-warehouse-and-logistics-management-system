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
