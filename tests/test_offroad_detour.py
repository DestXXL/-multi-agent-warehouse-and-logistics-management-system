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

    def test_blocked_lane_waits_for_traffic_or_uses_marked_bypass(self):
        sim = self.make_sim()
        self.assertIsNone(sim._plan_route((0, 0), (4, 0), {(2, 0)}, heading=0))
        self.assertEqual(sim._plan_route((0, 0), (4, 0), set()), [(1, 0), (2, 0), (3, 0), (4, 0)])
        bypass = [(0, 0), (0, 1), (0, 2), (1, 2), (2, 2), (3, 2), (4, 2), (4, 1), (4, 0)]
        edges = sim.roads() | set(zip(bypass, bypass[1:]))
        sim.roads = lambda: edges
        self.assertEqual(sim._plan_route((0, 0), (4, 0), {(2, 0)}, heading=0), bypass[1:])

    def test_does_not_bypass_closed_or_occupied_destination(self):
        sim = self.make_sim()
        self.assertIsNone(sim._plan_route((0, 0), (2, 0), {(2, 0)}))
        sim.zone_agent.blocked_cells.add((4, 0))
        self.assertIsNone(sim._plan_route((0, 0), (4, 0), {(2, 0)}))
