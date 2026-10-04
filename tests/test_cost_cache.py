"""The Azure response cache, and the stale-while-revalidate behaviour on top of it.

Measured against the live deployment, these are the endpoints this cache decides:

    cold    warm
    6.8s    0.11s   /api/dashboard/waste
    6.6s    0.11s   /api/dashboard/governance
    8.0s    -       /api/exports

Before stale-while-revalidate, "warm" lasted exactly CACHE_TTL_SECONDS and then the next
person to open the tab paid the full cold cost again for data that had not changed. So
what is worth testing is not that a cache exists, but that an expired entry is *served*
while it is replaced, that ten readers cause one refresh rather than ten, that a refresh
which fails does not surface to the reader, and that none of it can outlive a write or
leak between callers.

The HTTP layer is replaced; everything below it is the real code path.
"""
from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path
from typing import ClassVar

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import cost  # noqa: E402

URL = "https://management.azure.com/subscriptions/x/providers/Microsoft.CostManagement/query"


class _Response:
    def __init__(self, payload: dict) -> None:
        self._payload = payload
        self.status_code = 200
        self.headers: dict[str, str] = {}
        self.text = "{}"
        self.content = b"{}"

    def json(self) -> dict:
        return self._payload


class _Client:
    """Stands in for httpx.AsyncClient, counting the calls that reach the network."""

    calls: ClassVar[list[str]] = []
    payload: ClassVar[dict] = {"value": 1}
    fail: ClassVar[bool] = False
    # Held open to keep calls genuinely in flight. Without it nothing here ever suspends, so
    # "concurrent" requests would run to completion one after another and a stampede could not
    # be reproduced -- the second reader would always find the first one's cache entry.
    block: ClassVar[asyncio.Event | None] = None

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def request(self, method, url, **kwargs):
        type(self).calls.append(url)
        if type(self).fail:
            raise RuntimeError("Azure is unreachable")
        # Read before waiting, so a call that was already out answers with what Azure held when
        # it left rather than picking up a value the test set while it was blocked.
        payload = type(self).payload
        if type(self).block is not None:
            await type(self).block.wait()
        return _Response(payload)


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    """A fresh cache, a stubbed transport, and no real credential."""
    cost.clear_cache()
    cost._refreshing.clear()
    cost._inflight.clear()
    _Client.calls = []
    _Client.payload = {"value": 1}
    _Client.fail = False
    _Client.block = None
    monkeypatch.setattr(cost.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(cost.Azure, "_bearer", lambda self, url = "": _token())
    monkeypatch.setattr(cost, "_CACHE_TTL", 300.0)
    monkeypatch.setattr(cost, "_CACHE_STALE", 900.0)
    yield
    cost.clear_cache()
    cost._refreshing.clear()
    cost._inflight.clear()


async def _token() -> str:
    return "token"


@pytest.mark.asyncio
async def test_client_construction_yields_and_preserves_caller_context(monkeypatch):
    started, release = threading.Event(), threading.Event()
    loop_thread = threading.get_ident()
    observed = {}

    class Client(_Client):
        def __init__(self, **kwargs):
            observed.update(constructor_thread=threading.get_ident(),
                            caller=cost._caller_id.get(), kwargs=kwargs)
            started.set()
            release.wait(2)

        async def request(self, *args, **kwargs):
            observed["request_thread"] = threading.get_ident()
            return await super().request(*args, **kwargs)

    monkeypatch.setattr(cost.httpx, "AsyncClient", Client)
    token = cost._caller_id.set("caller-isolated")
    request = asyncio.create_task(cost.Azure().request("GET", URL, cache=False))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        assert not release.is_set() and not request.done()
        assert observed["constructor_thread"] != loop_thread
        release.set()
        assert await request == {"value": 1}
        assert observed["caller"] == "caller-isolated"
        assert observed["kwargs"] == {"timeout": 90}
        assert observed["request_thread"] == loop_thread
    finally:
        release.set()
        await asyncio.gather(request, return_exceptions=True)
        cost._caller_id.reset(token)


@pytest.mark.asyncio
async def test_cancelled_client_construction_closes_without_network_call(monkeypatch):
    started, release = threading.Event(), threading.Event()
    closed = asyncio.Event()

    class Client(_Client):
        def __init__(self, **kwargs):
            started.set()
            release.wait(2)

        async def aclose(self):
            closed.set()

    async def read():
        async with cost.async_client(timeout=90) as client:
            await client.request("GET", URL)

    monkeypatch.setattr(cost.httpx, "AsyncClient", Client)
    request = asyncio.create_task(read())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        request.cancel()
        await asyncio.sleep(0)
        request.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert closed.is_set()
        assert _Client.calls == []
    finally:
        release.set()
        await asyncio.gather(request, return_exceptions=True)


@pytest.mark.asyncio
async def test_offloaded_client_preserves_transport_options_and_closes_on_failure(monkeypatch):
    options = {"timeout": cost.httpx.Timeout(30, connect=5), "follow_redirects": False,
               "verify": True, "trust_env": True}
    observed = {}
    loop_thread = threading.get_ident()

    class Client(_Client):
        def __init__(self, **kwargs):
            observed["options"] = kwargs

        async def __aexit__(self, *exc):
            observed.update(exit_thread=threading.get_ident(), exception=exc[0])

    monkeypatch.setattr(cost.httpx, "AsyncClient", Client)
    with pytest.raises(RuntimeError, match="read failed"):
        async with cost.async_client(**options):
            raise RuntimeError("read failed")
    assert observed["options"] == options
    assert observed["exit_thread"] == loop_thread
    assert observed["exception"] is RuntimeError


async def _settle() -> None:
    """Let any background refresh finish before asserting on it."""
    tasks = tuple(cost._refresh_tasks)
    if tasks:
        await asyncio.wait_for(asyncio.gather(*tasks), 2)


async def _wait_calls(count: int) -> None:
    async def wait():
        while len(_Client.calls) < count:
            await asyncio.sleep(0.001)
    await asyncio.wait_for(wait(), 2)


def _age(seconds: float) -> None:
    """Push every cached entry `seconds` further into the past."""
    for key, (expiry, payload, url) in list(cost._cache.items()):
        cost._cache[key] = (expiry - seconds, payload, url)


@pytest.mark.asyncio
async def test_a_fresh_entry_is_served_without_touching_the_network():
    azure = cost.Azure()
    assert await azure.request("GET", URL) == {"value": 1}
    assert await azure.request("GET", URL) == {"value": 1}
    assert len(_Client.calls) == 1


@pytest.mark.asyncio
async def test_an_expired_entry_is_still_served_immediately():
    azure = cost.Azure()
    await azure.request("GET", URL)
    _age(301)

    _Client.payload = {"value": 2}
    # The reader gets the old answer rather than waiting for the new one.
    assert await azure.request("GET", URL) == {"value": 1}

    await _settle()
    assert len(_Client.calls) == 2, "the stale read should have refreshed behind the reader"
    # And the refreshed value is what the next reader sees.
    assert await azure.request("GET", URL) == {"value": 2}
    assert len(_Client.calls) == 2


@pytest.mark.asyncio
async def test_many_stale_readers_cause_one_refresh():
    azure = cost.Azure()
    await azure.request("GET", URL)
    _age(301)

    results = await asyncio.gather(*(azure.request("GET", URL) for _ in range(10)))
    assert results == [{"value": 1}] * 10
    await _settle()
    assert len(_Client.calls) == 2, "ten stale readers must not become ten Azure calls"


@pytest.mark.asyncio
async def test_concurrent_cold_readers_cause_one_call():
    """The stampede `_refreshing` never covered: a key nobody has fetched yet.

    Ten callers arrive together, all miss, and before this was collapsed all ten went to
    Azure. `list_subscriptions()` alone has about two dozen call sites, and three identical
    `GET /subscriptions` went out on every startup.
    """
    azure = cost.Azure()
    _Client.block = asyncio.Event()

    readers = [asyncio.create_task(azure.request("GET", URL)) for _ in range(10)]
    # Let every one of them reach the network before any of them is allowed to finish.
    await _wait_calls(1)
    _Client.block.set()

    assert await asyncio.gather(*readers) == [{"value": 1}] * 10
    assert len(_Client.calls) == 1, "ten cold readers must not become ten Azure calls"


@pytest.mark.asyncio
async def test_one_reader_giving_up_does_not_abort_the_others():
    """Cancelling a waiter must not cancel the shared fetch underneath it."""
    azure = cost.Azure()
    _Client.block = asyncio.Event()

    leaves = asyncio.create_task(azure.request("GET", URL))
    stays = asyncio.create_task(azure.request("GET", URL))
    await _wait_calls(1)

    leaves.cancel()
    _Client.block.set()

    assert await stays == {"value": 1}
    assert len(_Client.calls) == 1


@pytest.mark.asyncio
async def test_a_reader_after_a_write_does_not_join_the_fetch_before_it():
    """Read-after-write, for a fetch that was already in flight when the write landed.

    Collapsing concurrent readers onto one call would otherwise reintroduce exactly what
    `forget()` exists to prevent: an answer Azure gave before the change, handed to someone
    who asked after it.
    """
    azure = cost.Azure()
    _Client.block = asyncio.Event()

    before = asyncio.create_task(azure.request("GET", URL))
    await _wait_calls(1)

    cost.forget("Microsoft.CostManagement")
    _Client.payload = {"value": 2}

    after = asyncio.create_task(azure.request("GET", URL))
    await _wait_calls(2)
    _Client.block.set()

    assert await before == {"value": 1}
    assert await after == {"value": 2}, "a write must not be answered by a fetch that predates it"
    assert len(_Client.calls) == 2


@pytest.mark.asyncio
async def test_concurrent_cold_readers_are_not_shared_between_callers():
    """The collapse is keyed on the cache key, which carries the caller. It must stay that way."""
    azure = cost.Azure()
    _Client.block = asyncio.Event()

    async def read_as(who: str) -> dict:
        token = cost._caller_id.set(who)
        try:
            return await azure.request("GET", URL)
        finally:
            cost._caller_id.reset(token)

    alice = asyncio.create_task(read_as("alice"))
    bob = asyncio.create_task(read_as("bob"))
    await _wait_calls(2)
    _Client.block.set()

    await asyncio.gather(alice, bob)
    assert len(_Client.calls) == 2, "two identities must never share one answer"


@pytest.mark.asyncio
async def test_a_refresh_that_fails_is_invisible_to_the_reader():
    azure = cost.Azure()
    await azure.request("GET", URL)
    _age(301)

    _Client.fail = True
    assert await azure.request("GET", URL) == {"value": 1}
    await _settle()

    # Still serving the last good answer, and still willing to try again.
    _Client.fail = False
    assert await azure.request("GET", URL) == {"value": 1}
    await _settle()
    assert await azure.request("GET", URL) == {"value": 1}


@pytest.mark.asyncio
async def test_past_the_stale_window_the_caller_waits_for_a_real_answer():
    azure = cost.Azure()
    await azure.request("GET", URL)
    _age(300 + 900 + 1)

    _Client.payload = {"value": 2}
    assert await azure.request("GET", URL) == {"value": 2}, "too old to serve"
    assert len(_Client.calls) == 2


@pytest.mark.asyncio
async def test_a_write_purges_the_stale_copy_too():
    """Read-after-write must never be answered from a stale entry."""
    azure = cost.Azure()
    await azure.request("GET", URL)
    _age(301)

    assert cost.forget("Microsoft.CostManagement") == 1
    _Client.payload = {"value": 2}
    assert await azure.request("GET", URL) == {"value": 2}


@pytest.mark.asyncio
async def test_a_stale_entry_is_not_shared_between_callers():
    azure = cost.Azure()
    token = cost._caller_id.set("alice")
    try:
        await azure.request("GET", URL)
    finally:
        cost._caller_id.reset(token)
    _age(301)

    _Client.payload = {"value": 2}
    token = cost._caller_id.set("bob")
    try:
        # Bob has no entry of his own, stale or otherwise, so he gets his own answer.
        assert await azure.request("GET", URL) == {"value": 2}
    finally:
        cost._caller_id.reset(token)


@pytest.mark.asyncio
async def test_the_behaviour_can_be_turned_off(monkeypatch):
    monkeypatch.setattr(cost, "_CACHE_STALE", 0.0)
    azure = cost.Azure()
    await azure.request("GET", URL)
    _age(301)

    _Client.payload = {"value": 2}
    assert await azure.request("GET", URL) == {"value": 2}, "no stale window means no stale read"


@pytest.mark.asyncio
async def test_cache_stats_distinguishes_fresh_from_stale():
    azure = cost.Azure()
    await azure.request("GET", URL)
    assert cost.cache_stats()["entries"] == 1
    assert cost.cache_stats()["stale"] == 0

    _age(301)
    stats = cost.cache_stats()
    assert stats["entries"] == 0 and stats["stale"] == 1


@pytest.mark.asyncio
async def test_the_cache_does_not_grow_without_bound(monkeypatch):
    """Entries are only dropped when read, so a one-off query would otherwise live forever."""
    monkeypatch.setattr(cost, "_CACHE_MAX_ENTRIES", 50)
    azure = cost.Azure()
    for i in range(120):
        await azure.request("GET", f"{URL}?q={i}")
    assert len(cost._cache) <= 50 + 1, f"cache grew to {len(cost._cache)}"


@pytest.mark.asyncio
async def test_pruning_keeps_the_freshest_entries(monkeypatch):
    monkeypatch.setattr(cost, "_CACHE_MAX_ENTRIES", 10)
    azure = cost.Azure()
    for i in range(10):
        await azure.request("GET", f"{URL}?old={i}")
    _age(300 + 900 + 1)          # every one of those is now past use
    for i in range(5):
        await azure.request("GET", f"{URL}?new={i}")
    assert len(cost._cache) == 5
    # The survivors are the recent ones, and they are still served without a network call.
    before = len(_Client.calls)
    await azure.request("GET", f"{URL}?new=0")
    assert len(_Client.calls) == before
