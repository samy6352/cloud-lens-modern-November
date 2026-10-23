"""Stopped PostgreSQL servers are started on request, at most once per interval, and only when allowed."""
from __future__ import annotations

import asyncio

import pytest

from app import db_wake

SERVER = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/db"


class FakeAzure:
    def __init__(self, state: str):
        self.state = state
        self.gets = 0

    async def request(self, method, url, **kwargs):
        self.gets += 1
        return {"properties": {"state": self.state}}

    async def _bearer(self, url=""):
        return "token"


class FakeHttp:
    posts: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None):
        FakeHttp.posts.append(url)

        class Response:
            status_code = 202

        return Response()


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    db_wake._reset_for_tests()
    FakeHttp.posts = []
    monkeypatch.setenv("POSTGRES_SERVER_ID", SERVER)
    monkeypatch.delenv("CLOUDLENS_READ_ONLY", raising=False)
    monkeypatch.delenv("CLOUDLENS_DATABASE_READ_ONLY", raising=False)
    monkeypatch.setattr(db_wake.httpx, "AsyncClient", FakeHttp)
    yield
    db_wake._reset_for_tests()


def _run(azure: FakeAzure, monkeypatch) -> None:
    from app import cost

    monkeypatch.setattr(cost, "azure", azure)

    async def scenario():
        assert db_wake.kick(clock=lambda: 1000.0)
        await db_wake._task

    asyncio.run(scenario())


def test_stopped_server_is_started(monkeypatch):
    _run(FakeAzure("Stopped"), monkeypatch)
    assert FakeHttp.posts == [f"https://management.azure.com{SERVER}/start?api-version=2024-08-01"]


def test_running_server_is_left_alone(monkeypatch):
    _run(FakeAzure("Ready"), monkeypatch)
    assert FakeHttp.posts == []


def test_start_is_rate_limited(monkeypatch):
    from app import cost

    monkeypatch.setattr(cost, "azure", FakeAzure("Stopped"))

    async def scenario():
        assert db_wake.kick(clock=lambda: 1000.0)
        await db_wake._task
        assert not db_wake.kick(clock=lambda: 1000.0 + 599)
        assert db_wake.kick(clock=lambda: 1000.0 + 601)
        await db_wake._task

    asyncio.run(scenario())


def test_disabled_without_server_id_or_in_read_only(monkeypatch):
    monkeypatch.delenv("POSTGRES_SERVER_ID")
    assert db_wake.kick(clock=lambda: 1000.0) is False
    monkeypatch.setenv("POSTGRES_SERVER_ID", SERVER)
    monkeypatch.setenv("CLOUDLENS_READ_ONLY", "true")
    assert db_wake.kick(clock=lambda: 1000.0) is False
    assert FakeHttp.posts == []
