"""Setup pauses Azure's native export schedule unless FOCUS_PAUSE_NATIVE_SCHEDULE=false."""
from __future__ import annotations

import pytest

from app import cost_data


def test_native_schedule_is_paused_by_default(monkeypatch):
    monkeypatch.delenv("FOCUS_PAUSE_NATIVE_SCHEDULE", raising=False)
    assert cost_data._pause_native_schedule() is True


@pytest.mark.parametrize("value", ["false", "FALSE", " false "])
def test_native_schedule_pause_can_be_switched_off(monkeypatch, value):
    monkeypatch.setenv("FOCUS_PAUSE_NATIVE_SCHEDULE", value)
    assert cost_data._pause_native_schedule() is False
