"""Start this deployment's PostgreSQL flexible server when a request finds it stopped.

Tenant policy stops the database overnight, and the app keeps serving without it. The first
user request after that should not stay down, so it asks ARM to start the server. The
identity may only read and start that one server (see the CloudLens PostgreSQL Starter role).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Callable

import httpx

from .job_policy import read_only_mode

log = logging.getLogger(__name__)

API_VERSION = "2024-08-01"
MIN_INTERVAL_SECONDS = 600.0

_last_attempt = float("-inf")
_task: asyncio.Task | None = None


def _server_id() -> str:
    """ARM resource ID of the server, from POSTGRES_SERVER_ID. Empty disables the wake."""
    return os.getenv("POSTGRES_SERVER_ID", "").strip()


def kick(*, clock: Callable[[], float] = time.monotonic) -> bool:
    """Start the server in the background, at most once per MIN_INTERVAL_SECONDS.

    Returns True when a start was scheduled. Never blocks the request that triggered it.
    """
    global _last_attempt, _task
    server = _server_id()
    if not server or read_only_mode():
        return False
    now = clock()
    if now - _last_attempt < MIN_INTERVAL_SECONDS:
        return False
    if _task is not None and not _task.done():
        return False
    _last_attempt = now
    _task = asyncio.get_running_loop().create_task(_start(server), name="db-wake")
    return True


async def _start(server: str) -> None:
    from .cost import ARM, azure

    try:
        url = f"{ARM}{server}?api-version={API_VERSION}"
        state = (await azure.request("GET", url, cache=False)).get("properties", {}).get("state")
        if state != "Stopped":
            return
        token = await azure._bearer(url)
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(f"{ARM}{server}/start?api-version={API_VERSION}",
                                         headers={"Authorization": f"Bearer {token}"})
        log.info("database start requested (status %s)", response.status_code)
    except Exception as error:  # noqa: BLE001 - a failed wake must not affect requests
        log.warning("database start failed (%s)", type(error).__name__)


async def is_scheduled() -> bool:
    return _task is not None and not _task.done()


def _reset_for_tests() -> None:
    global _last_attempt, _task
    _last_attempt = float("-inf")
    _task = None
