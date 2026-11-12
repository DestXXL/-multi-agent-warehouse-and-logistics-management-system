import asyncio
import json
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from backend.harness import AgentHarness, Settings
from backend.planning import planning_pass, compare_shift
from backend.simulation import WarehouseSimulation


def reply(selected=None, reason="По фактам"):
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
        "selected": selected or [], "reason": reason,
    })}}], "usage": {"total_tokens": 70}})


class HarnessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.sim = WarehouseSimulation()
        self.harness = AgentHarness()
        self.harness.key = "test-secret-value"
        self.sim.harness = self.harness
        self.sim.dispatch_mode = "model"

    async def call(self, handler, role="operator", data=None):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await self.harness.consult(client, self.sim, role, data or {"facts": ["Один заказ"]})

    async def test_payload_settings_usage_and_redaction(self):
        self.harness.configure(Settings(model=self.harness.settings.model, temperature=0.2, max_tokens=200))
        def response(request):
            body = json.loads(request.content)
            self.assertEqual(body["temperature"], 0.2)
            self.assertEqual(body["max_tokens"], 200)
            self.assertEqual(body["response_format"], {"type": "json_object"})
            self.assertNotIn("tools", body)  # Bounded choices, no arbitrary tool calls.
            return reply(reason="test-secret-value")
        result = await self.call(response, data={"facts": ["test-secret-value"], "api_key": "other"})
        self.harness.resolve(result, "Ответ показан")
        self.assertEqual(self.harness.tokens, 70)
        self.assertEqual(self.sim.metrics["requests"], 1)
        self.assertNotIn("test-secret-value", json.dumps(self.harness.history[0]))
        self.assertNotIn("api_key", self.harness.history[0]["context"])
        self.assertNotIn("context", self.harness.public()["history"][0])
        self.assertEqual(self.harness.history[0]["outcome"], "Ответ показан")

    async def test_demo_full_cycle_without_transport_or_tokens(self):
        self.sim.dispatch_mode = "demo"
        self.sim.start(assign_orders=False)
        await planning_pass(self.sim)
        self.assertTrue(any(o.status == "assigned" for o in self.sim.warehouse.orders))
        self.assertEqual(self.sim.decisions[0]["source"], "demo")
        self.assertEqual(self.harness.requests, 0)
        self.assertTrue(self.harness.history[0]["outcome"].startswith("Принято"))

    async def test_unknown_id_falls_back_without_invented_resources(self):
        self.sim.start(assign_orders=False)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: reply(["imaginary-plan"]))) as client:
            await planning_pass(self.sim, client)
        self.assertEqual(self.harness.errors, 1)
        self.assertEqual(self.sim.decisions[0]["source"], "rules")
        self.assertGreater(self.sim.metrics["fallbacks"], 0)
        self.assertTrue(all(o.robot_id in (None, "R-01", "R-02") for o in self.sim.warehouse.orders))

    async def test_http_limits_and_failures_have_cooldown(self):
        for code in (401, 403, 429, 500):
            with self.subTest(code=code):
                self.harness.cooldown_until = 0
                result = await self.call(lambda _: httpx.Response(code, text="sensitive server details"))
                self.assertIsNone(result)
                self.assertGreater(self.harness.public()["cooldown_seconds"], 0)
                self.assertNotIn("sensitive", json.dumps(self.harness.public()))
        calls = self.harness.requests
        self.assertIsNone(await self.call(lambda _: self.fail("Cooldown must not call API")))
        self.assertEqual(calls, self.harness.requests)

    async def test_timeout_and_offline_are_safe(self):
        for error in (httpx.ReadTimeout("secret"), httpx.ConnectError("secret")):
            self.harness.cooldown_until = 0
            def fail(_):
                raise error
            self.assertIsNone(await self.call(fail))
            self.assertNotIn("secret", self.harness.last_error)
            self.assertFalse(self.harness.inflight)

    async def test_actual_deadline_cancels_transport(self):
        self.harness.settings = Settings(timeout=1)
        async def delayed(_):
            await asyncio.sleep(2)
            return reply()
        self.assertIsNone(await self.call(delayed))
        self.assertEqual(self.harness.history[0]["status"], "error")

    async def test_invalid_responses_are_rejected(self):
        for body in ([], {}, {"choices": []}, {"choices": [{"message": {"content": "not JSON"}}]}):
            self.harness.cooldown_until = 0
            self.assertIsNone(await self.call(lambda _: httpx.Response(200, json=body)))
        self.harness.cooldown_until = 0
        self.assertIsNone(await self.call(lambda _: reply(reason=" ")))

    async def test_request_budget_survives_simulation_reset(self):
        self.harness.settings = Settings(request_limit=1)
        self.assertIsNotNone(await self.call(lambda _: reply()))
        self.sim.reset()
        self.assertIsNone(await self.call(lambda _: self.fail("Budget must prevent call")))
        self.assertEqual(self.harness.requests, 1)

    async def test_missing_usage_and_token_budget(self):
        self.harness.settings = Settings(max_tokens=4096, token_limit=4096)
        def response(_):
            r = reply()
            body = r.json(); del body["usage"]
            return httpx.Response(200, json=body)
        await self.call(response)
        self.assertEqual(self.harness.unknown_usage, 1)
        self.assertTrue(self.harness.public()["budget_exhausted"])

    async def test_cancellation_releases_lifecycle(self):
        async def cancel(_):
            raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.call(cancel)
        self.assertFalse(self.harness.inflight)
        self.assertEqual(self.harness.history[0]["status"], "cancelled")

    async def test_unchanged_autonomous_context_not_repeated_each_tick(self):
        data = {"plans": {"plan-1": ["order-1"]}, "options": {}, "tick": 1}
        self.assertIsNotNone(await self.call(lambda _: reply(["plan-1"]), "manager", data))
        data["tick"] = 2
        self.assertIsNone(await self.call(lambda _: self.fail("Duplicate request"), "manager", data))

    async def test_delayed_answer_after_pause_or_mode_change_is_not_applied(self):
        for change in (lambda: self.sim.pause(), lambda: setattr(self.sim, "dispatch_mode", "rules")):
            self.sim = WarehouseSimulation(); self.sim.harness = self.harness
            self.sim.dispatch_mode = "model"; self.sim.start(assign_orders=False)
            self.harness.seen.clear()
            def response(request):
                data = json.loads(json.loads(request.content)["messages"][1]["content"])
                change()
                return reply([next(iter(data["plans"]))])
            async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
                await planning_pass(self.sim, client)
            self.assertTrue(all(o.status == "pending" for o in self.sim.warehouse.orders))
            self.assertTrue(self.harness.history[0]["outcome"].startswith("Отклонено"))

    async def test_demo_comparison_does_not_modify_current_shift(self):
        before = self.sim.warehouse.to_dict()
        metrics = await compare_shift(None, "demo", self.harness)
        self.assertEqual(before, self.sim.warehouse.to_dict())
        self.assertEqual(metrics["requests"], 0)
        self.assertEqual(metrics["source"], "demo")
        self.assertIn("elapsed_ms", metrics)


class HarnessAPITests(unittest.TestCase):
    def setUp(self):
        from backend import main
        self.main = main
        self.sim = WarehouseSimulation()
        self.harness = AgentHarness(); self.harness.key = ""
        self.sim.harness = self.harness
        self.patches = [patch.object(main, "simulation", self.sim), patch.object(main, "harness", self.harness)]
        for item in self.patches:
            item.start(); self.addCleanup(item.stop)
        self.client = TestClient(main.app)

    def test_settings_reject_unknown_models_and_secrets(self):
        settings = self.harness.settings.model_dump()
        self.assertEqual(self.client.put("/api/dispatch/settings", json={**settings, "model": "unapproved"}).status_code, 409)
        self.assertEqual(self.client.put("/api/dispatch/settings", json={**settings, "api_key": "secret"}).status_code, 422)
        response = self.client.put("/api/dispatch/settings", json={**settings, "max_tokens": 300})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.harness.settings.max_tokens, 300)

    def test_modes_without_credentials_and_offline_assistant(self):
        self.assertEqual(self.client.post("/api/dispatch/mode", json={"mode": "model"}).status_code, 409)
        self.assertEqual(self.client.post("/api/dispatch/mode", json={"mode": "demo"}).status_code, 200)
        answer = self.client.post("/api/dispatch/ask", json={"question": "Почему техника ждёт?"}).json()
        self.assertEqual(answer["source"], "demo")
        self.assertTrue(answer["answer"].startswith("Демонстрация"))
        row = self.harness.history[0]
        self.assertEqual(self.client.get("/api/dispatch/history/" + row["id"]).status_code, 200)
        self.assertEqual(self.client.get("/api/dispatch/history/unknown").status_code, 404)
        self.assertEqual(self.client.post("/api/dispatch/test").status_code, 409)

    def test_connection_button_uses_real_request_path_with_mock(self):
        self.harness.key = "hidden-value"
        def response(request):
            self.assertEqual(request.headers["Authorization"], "Bearer hidden-value")
            return reply()
        with patch.object(self.main, "model_client", lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(response), headers={"Authorization": "Bearer hidden-value"},
        )):
            result = self.client.post("/api/dispatch/test")
        self.assertTrue(result.json()["ok"])
        self.assertNotIn("hidden-value", result.text)
        self.assertEqual(self.harness.requests, 1)

    def test_demo_new_cargo_uses_validated_storage_plan(self):
        self.client.post("/api/dispatch/mode", json={"mode": "demo"})
        response = self.client.post("/api/orders", json={"item": "Новая коробка", "dropoff": [11, 1]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.harness.requests, 0)
        self.assertTrue(any(row["role"] == "storage" for row in self.harness.history))
        self.assertEqual(self.harness.history[0]["source"], "demo")
        self.assertTrue(self.harness.history[0]["outcome"].startswith("Принято"))

    def test_stale_storage_proposal_cannot_create_cargo(self):
        self.sim.dispatch_mode = "model"
        initial = len(self.sim.warehouse.inventory)
        def response(request):
            data = json.loads(json.loads(request.content)["messages"][1]["content"])
            self.sim.stop_robot("R-01")
            return reply([next(iter(data["options"]))])
        with patch.object(self.main, "model_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(response))):
            result = self.client.post("/api/orders", json={"item": "Новая коробка", "dropoff": [11, 1]})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(initial, len(self.sim.warehouse.inventory))
        self.assertTrue(self.harness.history[0]["outcome"].startswith("Отклонено"))

    def test_facts_describe_executing_orders_and_priorities(self):
        self.sim.start()
        response = self.client.post("/api/dispatch/ask", json={"question": "Какие заказы выполняются?"})
        facts = " ".join(response.json()["facts"])
        self.assertIn("assigned", facts)
        self.assertIn("приоритет", facts)
        self.assertIn("задание ORD-", facts)


if __name__ == "__main__":
    unittest.main()
