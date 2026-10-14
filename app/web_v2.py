"""The v3 web interface (React, built from `ui/` into `web/v2/`), served at /v2.

It is the only interface: `/` redirects here. It shares the session cookie, the `RequireAuth` gate,
the `/api/*` routes and the Content-Security-Policy with the sign-in page. The build contains no
inline script, so that policy does not have to loosen for it.

A checkout that has never run `npm run build` still starts; /v2 then explains what is missing
instead of failing.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import FileResponse, PlainTextResponse, Response

from .assets import PrecompressedStatic

PREFIX = "/v2"
ASSETS_PREFIX = f"{PREFIX}/assets/"

# Vite names every file under assets/ by content hash, so a URL never changes meaning.
IMMUTABLE = "public, max-age=31536000, immutable"
_TOP_LEVEL_FILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


class HashedStatic(PrecompressedStatic):
    """Content-hashed build output: cache forever, and 404 (not 500) before the first build."""

    async def check_config(self) -> None:
        # Starlette raises on a missing directory at the first request. Before `npm run build`
        # that is the normal state, and get_response below already answers it with a 404.
        if self.directory is not None and Path(self.directory).is_dir():
            await super().check_config()

    async def get_response(self, path: str, scope: Any) -> Response:
        if self.directory is None or not Path(self.directory).is_dir():
            return Response(status_code=404, headers={"Cache-Control": "no-store"})
        response = await super().get_response(path, scope)
        if response.status_code in {200, 206, 304}:
            response.headers["Cache-Control"] = IMMUTABLE
        return response


def install(app: FastAPI, web: Path) -> None:
    root = web / "v2"
    app.mount(ASSETS_PREFIX.rstrip("/"), HashedStatic(directory=root / "assets", check_dir=False),
              name="v2-assets")

    def shell() -> Response:
        index = root / "index.html"
        if not index.is_file():
            return PlainTextResponse(
                "The CloudLens v3 interface has not been built. Run `npm ci && npm run build` in ui/.",
                status_code=503, headers={"Cache-Control": "no-store", "Retry-After": "60"})
        # no-store: the shell sits behind a sign-in, so it must not be cached.
        return FileResponse(index, media_type="text/html", headers={"Cache-Control": "no-store"})

    @app.get(PREFIX, include_in_schema=False)
    async def v2_root() -> Response:
        return shell()

    @app.get(PREFIX + "/{path:path}", include_in_schema=False)
    async def v2_route(path: str) -> Response:
        name = path.rsplit("/", 1)[-1]
        if "." not in name:
            # A client-side route (/v2/explore/billing): the SPA resolves it.
            return shell()
        # Only real files that sit directly in the build root (theme.js, favicon.svg). Anything
        # else that looks like a file is a 404 rather than index.html served under a .js name.
        if "/" in path or not _TOP_LEVEL_FILE.fullmatch(name) or name == "index.html":
            return Response(status_code=404, headers={"Cache-Control": "no-store"})
        candidate = root / name
        if not candidate.is_file():
            return Response(status_code=404, headers={"Cache-Control": "no-store"})
        return FileResponse(candidate, headers={"Cache-Control": "no-cache"})
