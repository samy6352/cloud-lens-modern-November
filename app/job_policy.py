"""Deployment-wide ingest policy; staging may still build local database caches."""
import os
from collections.abc import Mapping

DEFAULT_HISTORY_MONTHS = 3
MANAGED_HISTORY_MONTHS = 13


def initial_history_months(environment: Mapping[str, str] | None = None) -> int:
    env = os.environ if environment is None else environment
    raw = env.get("INGEST_MONTHS", str(DEFAULT_HISTORY_MONTHS)).strip()
    try:
        months = int(raw)
    except ValueError as exc:
        raise ValueError(f"INGEST_MONTHS must be an integer from 1 to {MANAGED_HISTORY_MONTHS}.") from exc
    if not 1 <= months <= MANAGED_HISTORY_MONTHS:
        raise ValueError(f"INGEST_MONTHS must be an integer from 1 to {MANAGED_HISTORY_MONTHS}.")
    return months


def read_only_mode() -> bool:
    return os.getenv("CLOUDLENS_READ_ONLY", "").strip().lower() in {"1", "true", "yes"}


def require_writable() -> None:
    if read_only_mode():
        raise PermissionError("CLOUDLENS_READ_ONLY is enabled; changes and ingest workers are disabled.")
