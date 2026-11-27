from random import Random
import asyncio
import unittest

from backend.planning import plan_zone
from backend.scenario import generate_shift
from backend.traffic import permits
from backend.simulation import WarehouseSimulation


class ShiftTests(unittest.TestCase):
    def test_generated_shifts_complete_and_replay_with_original_stock(self):
        for seed in (*range(16), 81):
            with self.subTest(seed=seed):
                layout, template = generate_shift(Random(seed))
                self.assertEqual(layout.errors(), [])
                sim = WarehouseSimulation()
                sim.custom_layout = layout
                sim.shift_template = (layout, template)
                sim.reset()
                initial = sim.warehouse.to_dict()
                # Exercise ticks without repeatedly serializing the same full map.
                sim.state = lambda: {}
                sim.start(automatic_handling=True)
                for _ in range(4):
                    sim.tick()
                self.assertTrue(all(r.position == r.home for r in sim.warehouse.robots))
                async def finish():
                    for _ in range(1200):
                        for robot in sim.warehouse.robots:
                            if robot.driver_phase == "offered":
                                sim.driver_action(robot.id, robot.order_id, "accept")
                        positions = {r.id: r.position for r in sim.warehouse.robots}
                        sim.tick()
                        for robot in sim.warehouse.robots:
                            previous = positions[robot.id]
                            if robot.position != previous:
                                self.assertIn((previous, robot.position), sim.roads())
                                self.assertTrue(permits(sim.warehouse.lanes, previous, robot.position))
                        await plan_zone(sim, None)
                        if all(o.status == "completed" for o in sim.warehouse.orders) and all(r.position == r.home for r in sim.warehouse.robots):
                            return
                    self.fail("Orders still open")
                asyncio.run(finish())
                self.assertTrue(all(o.picked_quantity == o.quantity for o in sim.warehouse.orders))
                sim.reset()
                self.assertEqual(initial, sim.warehouse.to_dict())
                self.assertFalse(sim.running)
