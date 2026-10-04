"""Per-request async HTTP clients without synchronous TLS setup on the event loop."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import httpx


@asynccontextmanager
async def async_client(**kwargs):
    # AsyncClient loads its TLS trust store synchronously. Concurrent warm-up
    # reads must not serialize certificate loading on the application loop.
    construction = asyncio.create_task(asyncio.to_thread(httpx.AsyncClient, **kwargs))
    try:
        client = await asyncio.shield(construction)
    except asyncio.CancelledError:
        while not construction.done():
            try:
                await asyncio.shield(construction)
            except asyncio.CancelledError:
                continue
        if not construction.cancelled() and construction.exception() is None:
            await construction.result().aclose()
        raise
    async with client:
        yield client
