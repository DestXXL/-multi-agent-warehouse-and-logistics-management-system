import asyncio
import json
import unittest

import httpx

from backend import dispatch
from backend.models import Robot
from backend.planning import planning_pass
from backend.simulation import WarehouseSimulation


class DispatchTests(unittest.TestCase):
    def test_rejects_overlapping_stock_reservations_for_entire_plan(self):
        sim = WarehouseSimulation()
        sim.add_order("Та же партия", (3, 1), (11, 6), "SKU-001", 11)
        proposal = dispatch.assignments(sim)
        keys = [
            next(key for key, row in proposal.facts.items() if row["order"] == order and row["robot"] == robot)
            for order, robot in [("ORD-001", "R-01"), ("ORD-004", "R-02")]
        ]
        before = sim.warehouse.to_dict()
        self.assertFalse(dispatch.apply_assignments(sim, proposal, keys, "План"))
        self.assertEqual(before, sim.warehouse.to_dict())

    def test_stale_proposal_cannot_assign_a_stopped_robot(self):
        sim = WarehouseSimulation()
        proposal = dispatch.assignments(sim)
        key = next(iter(proposal.options))
        sim.stop_robot(proposal.facts[key]["robot"])
        self.assertFalse(dispatch.apply_assignments(sim, proposal, [key], "План"))
        self.assertTrue(all(order.status == "pending" for order in sim.warehouse.orders))

    def test_model_applies_multiple_assignments_and_tracks_usage(self):
        sim = WarehouseSimulation()
        sim.dispatch_mode = "model"
        sim.start(assign_orders=False)

        def response(request):
            payload = json.loads(json.loads(request.content)["messages"][1]["content"])
            keys = [
                next(key for key, row in payload["options"].items() if row["order"] == order and row["robot"] == robot)
                for order, robot in [("ORD-001", "R-01"), ("ORD-002", "R-02")]
            ]
            plan = next(plan for plan, ids in payload["plans"].items() if set(keys) == set(ids))
            return httpx.Response(200, json={
                "choices": [{"message": {"content": json.dumps({"selected": [plan], "reason": "Две задачи"})}}],
                "usage": {"total_tokens": 100},
            })

        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
                return await planning_pass(sim, client)

        self.assertTrue(asyncio.run(run()))
        self.assertEqual([order.status for order in sim.warehouse.orders], ["assigned", "assigned", "pending"])
        self.assertEqual(sim.metrics["tokens"], 100)
        self.assertEqual(sim.decisions[0]["source"], "model")

    def test_yielding_resolves_two_vehicle_deadlock_on_custom_geometry(self):
        sim = WarehouseSimulation()
        warehouse = sim.warehouse
        warehouse.width, warehouse.height = 5, 2
        warehouse.obstacles = [(x, 1) for x in (0, 1, 3, 4)]
        warehouse.robots = [
            Robot("left", (1, 0), home=(4, 0), driver_phase="returning"),
            Robot("right", (2, 0), home=(0, 0), driver_phase="returning"),
        ]
        warehouse.orders = []
        sim.start()
        for _ in range(3):
            sim.tick()
        proposal = dispatch.zone_options(sim)
        self.assertTrue(proposal.options)
        self.assertTrue(dispatch.apply_zone(sim, proposal, next(iter(proposal.options))))
        for _ in range(10):
            sim.tick()
            self.assertEqual(len({robot.position for robot in warehouse.robots}), 2)
        self.assertEqual([robot.driver_phase for robot in warehouse.robots], ["idle", "idle"])
        self.assertEqual([robot.position for robot in warehouse.robots], [(4, 0), (0, 0)])
