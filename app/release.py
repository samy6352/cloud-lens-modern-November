"""Process-pinned package identity for deployment verification.

The packager supplies releaseId in the root release-manifest.json. Reading it once,
at import, distinguishes a restarted process from new files beneath an old process.
Local source runs without a manifest deliberately have no release identity.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

log = logging.getLogger("cloudlens.release")


def _load(path: Path) -> str | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        log.warning("Release identity could not be loaded (%s)", type(exc).__name__)
        return None
    value = payload.get("releaseId") if isinstance(payload, dict) else None
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        log.warning("Release manifest has no valid releaseId")
        return None
    return value


_RELEASE_ID = _load(Path(__file__).resolve().parents[1] / "release-manifest.json")


def release_id() -> str | None:
    return _RELEASE_ID
