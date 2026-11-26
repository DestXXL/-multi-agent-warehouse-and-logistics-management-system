import unittest
from backend.models import Robot
from backend.simulation import WarehouseSimulation


class DetourTests(unittest.TestCase):
    def make_sim(self):
        sim = WarehouseSimulation()
        w = sim.warehouse
        w.width, w.height = 5, 3
        w.racks = []
        w.obstacles = [(1, 1)]
        w.lanes = {(x, 0): 'east' for x in range(5)}
        w.robots = [Robot('R-01', (0, 0)), Robot('R-02', (2, 0))]
        edges = {((x, 0), (x + 1, 0)) for x in range(4)}
        sim.roads = lambda: edges
        return sim

    def test_prefers_road_and_bypasses_vehicle_without_crossing_obstacles(self):
        sim = self.make_sim()
        self.assertEqual(sim._plan_route((0, 0), (4, 0), set()), [(1, 0), (2, 0), (3, 0), (4, 0)])
        path = sim._plan_route((0, 0), (4, 0), {(2, 0)}, heading=0)
        self.assertTrue(path)
        self.assertNotIn((2, 0), path)
        self.assertNotIn((1, 1), path)
        self.assertTrue(any(y > 0 for x, y in path))
        robot = sim.warehouse.robots[0]
        for point in path:
            for _ in range(8):
                sim._advance(robot, [point], {(2, 0)})
                if robot.position == point:
                    break
            self.assertEqual(robot.position, point)

    def test_does_not_bypass_closed_or_occupied_destination(self):
        sim = self.make_sim()
        self.assertIsNone(sim._plan_route((0, 0), (2, 0), {(2, 0)}))
        sim.zone_agent.blocked_cells.add((4, 0))
        self.assertIsNone(sim._plan_route((0, 0), (4, 0), {(2, 0)}))
