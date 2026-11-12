"""Keep movement updates on cadence without an extra processing-time pause."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend import main


class SimulationTimingTests(unittest.TestCase):
    def test_tick_budget_includes_work_and_never_sleeps_negative_time(self):
        for work_seconds, expected_sleep in ((0.2, 0.8), (1.2, 0.0)):
            with self.subTest(work_seconds=work_seconds):
                clock = [100.0]
                sleeps = []

                def tick(**kwargs):
                    clock[0] += work_seconds / 2
                    return {}

                async def broadcast(state):
                    clock[0] += work_seconds / 2

                async def sleep(seconds):
                    sleeps.append(seconds)
                    raise asyncio.CancelledError

                sim = SimpleNamespace(running=True, dispatch_mode='model', TICK_SECONDS=1.0, tick=tick)
                runtime = SimpleNamespace(get_running_loop=lambda: SimpleNamespace(time=lambda: clock[0]), sleep=sleep)
                with patch.object(main, 'simulation', sim), patch.object(main, 'broadcast', broadcast), patch.object(main, 'asyncio', runtime):
                    with self.assertRaises(asyncio.CancelledError):
                        asyncio.run(main.simulation_loop())
                self.assertEqual(len(sleeps), 1)
                self.assertAlmostEqual(sleeps[0], expected_sleep)
