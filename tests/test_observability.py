"""Scoped live-evidence integration and PostgreSQL cost joins."""
from __future__ import annotations

import json
import os
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import HTTPException
from starlette.requests import Request

assert os.environ.get("PGSCHEMA", "").startswith("t_cl_test_observability_")

from app import cost, main, observability, reporting, service_health
from app.auth import User
from app.azure_updates import SourceError
from app.exports import _load_rows
from app.service_health import ScopeNotVisible
from app.warehouse import insert_rows, warehouse

A = "11111111-1111-1111-1111-111111111111"
B = "22222222-2222-2222-2222-222222222222"
RID = f"/subscriptions/{A}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm"
OTHER = RID.replace(A, B)
USER = User("alice", source="entra", sid="alice-session")
START, END = "2026-08-01T12:00:00Z", "2026-08-07T12:00:00Z"


class CostEvidence(unittest.TestCase):
    def setUp(self):
        header = ["ChargePeriodStart", "SubAccountId", "ResourceId", "BillingCurrency", "BilledCost"]
        rows, _ = _load_rows(header, [
            ["2026-08-01", A, RID, "USD", "4"],
            ["2026-08-03", A, RID.upper(), "USD", "6"],
            ["2026-08-03", A, RID, "EUR", "2"],
            ["2026-08-03", B, OTHER, "USD", "900"],
            ["2026-07-31", A, RID, "USD", "100"],
            ["2026-08-08", A, RID, "USD", "100"],
        ], None)
        with warehouse.connect() as con:
            con.execute("DELETE FROM costs")
            insert_rows(con, rows)

    def test_cost_join_keeps_scope_dates_case_and_currencies(self):
        with reporting.select("2025-01"):
            result = observability.resource_costs([A], [RID], START, END)
            self.assertEqual(reporting.selected_month(), "2025-01")
        item = result[RID.lower()]
        self.assertEqual(item["by_currency"], [
            {"currency": "EUR", "cost": 2.0}, {"currency": "USD", "cost": 10.0}])
        self.assertEqual((item["rows"], item["from"], item["to"]), (3, "2026-08-01", "2026-08-03"))

    def test_absent_rows_are_not_zero_cost(self):
        self.assertEqual(observability.resource_costs([A], [RID + "-absent"], START, END), {})
        self.assertEqual(observability.resource_costs([A], [], START, END), {})

    def test_scope_and_invalid_ids_fail_before_database_access(self):
        for scopes, ids in (([], [RID]), ([A], [OTHER]), ([A], ["not-an-id"]), ([A], [None])):
            with self.subTest(ids=ids), patch.object(warehouse, "connect") as connect:
                with self.assertRaises(SourceError):
                    observability.resource_costs(scopes, ids, START, END)
                connect.assert_not_called()

    def test_group_and_subscription_provider_ids_can_have_no_billing(self):
        ids = [f"/subscriptions/{A}/resourceGroups/rg",
               f"/subscriptions/{A}/providers/Microsoft.Authorization/policyAssignments/example"]
        self.assertEqual(observability.resource_costs([A], ids, START, END), {})

    def test_empty_scope_and_bad_window_are_not_silent_defaults(self):
        for days in (0, 15, -1, True, "7"):
            with self.assertRaises(SourceError):
                observability.evidence_window(days)
        window = observability.evidence_window(7)
        delta = datetime.fromisoformat(window["end"]) - datetime.fromisoformat(window["start"])
        self.assertEqual(delta.days, 7)
        with self.assertRaises(SourceError):
            observability.resource_costs([A], [RID], END, START)


class Routes(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def request(user=USER):
        request = Request({"type": "http", "path": "/", "headers": []})
        request.state.user = user
        return request

    async def test_unauthenticated_and_bad_scopes_never_call_source(self):
        loader = AsyncMock()
        with self.assertRaises(HTTPException) as caught:
            await main._live_evidence_response(self.request(None), A, 7, loader)
        self.assertEqual(caught.exception.status_code, 401)
        with patch.object(main, "permitted", AsyncMock(return_value=[A])):
            for scope, days, status in (("", 7, 400), ("invalid", 7, 400), (B, 7, 403),
                                         (A + "," + B, 7, 403), (A, 15, 400)):
                with self.subTest(scope=scope), self.assertRaises(HTTPException) as caught:
                    await main._live_evidence_response(self.request(), scope, days, loader)
                self.assertEqual(caught.exception.status_code, status)
        loader.assert_not_called()

    async def test_local_login_still_needs_explicit_scope(self):
        loader = AsyncMock()
        with patch.object(main, "permitted", AsyncMock(return_value=None)), \
                self.assertRaises(HTTPException) as caught:
            await main._live_evidence_response(self.request(User("local")), "", 7, loader)
        self.assertEqual(caught.exception.status_code, 400)
        loader.assert_not_called()

    async def test_delegated_context_is_scoped_and_restored(self):
        before = cost.acting_as()
        caller = cost.Caller("fallback", {A: "token-a", B: "token-b"})
        session = SimpleNamespace(oid="alice", sid=USER.sid)
        auth = SimpleNamespace(sso=SimpleNamespace(
            delegated=True, get=Mock(return_value=session), caller=AsyncMock(return_value=caller)))

        async def load(scopes, days):
            self.assertEqual(scopes, [A])
            self.assertEqual(days, 7)
            self.assertEqual(cost.acting_as(), "alice")
            self.assertEqual(cost.caller_token(f"{cost.ARM}/subscriptions/{A}"), "token-a")
            return {"status": "ok", "changes": []}

        with patch.object(main, "permitted", AsyncMock(return_value=[A, B])), \
                patch.object(main, "auth_service", return_value=auth):
            response = await main._live_evidence_response(self.request(), A.upper(), 7, load)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(json.loads(response.body)["status"], "ok")
        self.assertEqual(cost.acting_as(), before)

    async def test_failures_are_unavailable_not_empty_success(self):
        for error in (SourceError("No permission"), cost.CostError("Denied"), TimeoutError(),
                      httpx.ConnectError("network")):
            with patch.object(main, "permitted", AsyncMock(return_value=[A])), \
                    patch.object(main, "as_user", wraps=main.as_user), \
                    patch.object(main, "auth_service", return_value=SimpleNamespace(
                        sso=SimpleNamespace(delegated=False))):
                response = await main._live_evidence_response(
                    self.request(), A, 7, AsyncMock(side_effect=error))
            self.assertEqual(response.status_code, 502)
            payload = json.loads(response.body)
            self.assertEqual(payload["status"], "unavailable")
            self.assertTrue(payload["error"])
            self.assertNotIn("resources", payload)

    async def test_shared_arg_uses_explicit_token_groups_and_rejects_empty_scope(self):
        with patch.object(observability, "_groups", AsyncMock(return_value=[("token", [A])])) as groups, \
                patch.object(observability, "_query", AsyncMock(return_value={"rows": []})) as query:
            self.assertEqual(await observability.scoped_graph("resources", [A]), {"rows": []})
            groups.assert_awaited_once_with([A])
            query.assert_awaited_once_with("resources", [("token", [A])])
            with self.assertRaises(SourceError):
                await observability.scoped_graph("resources", [])
            self.assertEqual(query.await_count, 1)

    async def test_unreadable_subscriptions_are_an_unavailable_envelope_not_a_failure(self):
        # An identity that cannot see the subscriptions is an expected state: HTTP 200, but still
        # "unavailable" -- never an empty success -- with every field a screen needs to say why.
        empty = {"source": "Azure Resource Graph (resourcechanges)", "changes": []}
        with patch.object(main, "permitted", AsyncMock(return_value=[A])), \
                patch.object(main, "auth_service", return_value=SimpleNamespace(
                    sso=SimpleNamespace(delegated=False))):
            response = await main._live_evidence_response(
                self.request(), A, 7, AsyncMock(side_effect=ScopeNotVisible("Grant Reader.")), empty)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        payload = json.loads(response.body)
        self.assertEqual((payload["status"], payload["available"]), ("unavailable", False))
        self.assertEqual(payload["reason"], "Grant Reader.")
        self.assertEqual(payload["notices"], ["Grant Reader."])
        self.assertEqual((payload["changes"], payload["source"]), ([], empty["source"]))
        self.assertEqual(payload["window"]["days"], 7)
        self.assertTrue(payload["generated_at"].endswith("Z"))

    async def test_only_visibility_refusals_are_softened(self):
        # Throttling, outages, timeouts and other 4xx keep failing loudly.
        for error in (httpx.HTTPStatusError("x", request=httpx.Request("POST", "https://x"),
                                            response=httpx.Response(429)),
                      httpx.HTTPStatusError("x", request=httpx.Request("POST", "https://x"),
                                            response=httpx.Response(500)),
                      SourceError("Resource Graph returned invalid JSON."), TimeoutError()):
            with self.subTest(error=type(error).__name__), \
                    patch.object(main, "permitted", AsyncMock(return_value=[A])), \
                    patch.object(main, "auth_service", return_value=SimpleNamespace(
                        sso=SimpleNamespace(delegated=False))):
                response = await main._live_evidence_response(
                    self.request(), A, 7, AsyncMock(side_effect=error), {"changes": []})
            self.assertEqual(response.status_code, 502)
            self.assertNotIn("changes", json.loads(response.body))

    async def test_resource_graph_refusal_is_classified_from_its_error_code(self):
        def arg(status, body):
            def handler(request):
                return httpx.Response(status, content=body if isinstance(body, bytes) else json.dumps(body).encode())
            real = httpx.AsyncClient
            return patch.object(service_health.httpx, "AsyncClient",
                                lambda **kw: real(transport=httpx.MockTransport(handler), **kw))

        no_subs = {"error": {"code": "BadRequest", "details": [{"code": "NoValidSubscriptionsInQueryRequest"}]}}
        for status, body, expected in (
                (400, no_subs, ScopeNotVisible),
                (403, {"error": {"code": "AuthorizationFailed"}}, ScopeNotVisible),
                (400, {"error": {"code": "BadRequest", "details": [{"code": "InvalidQuery"}]}}, httpx.HTTPStatusError),
                (400, b"not json", httpx.HTTPStatusError),
                (400, {"error": "oops"}, httpx.HTTPStatusError),
                (429, no_subs, httpx.HTTPStatusError),
                (500, no_subs, httpx.HTTPStatusError)):
            with self.subTest(status=status, body=str(body)[:40]), arg(status, body):
                with self.assertRaises(expected):
                    await service_health._arg_page("Resources", [A], "token", {})

    async def test_scope_not_visible_is_still_a_source_error(self):
        # Other callers (Service Health) already treat SourceError as a safe, public message.
        self.assertTrue(issubclass(ScopeNotVisible, SourceError))

    async def test_both_routes_are_registered_before_dynamic_dashboard(self):
        paths = [route.path for route in main.app.routes]
        for path in ("/api/dashboard/change-analysis", "/api/dashboard/performance"):
            self.assertLess(paths.index(path), paths.index("/api/dashboard/{section_id}"))


if __name__ == "__main__":
    unittest.main()
