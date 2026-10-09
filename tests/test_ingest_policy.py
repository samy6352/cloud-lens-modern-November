"""Initial automatic history settings fail explicitly before any worker is started."""
import pytest

from app.job_policy import initial_history_months

pytestmark = pytest.mark.offline


def test_initial_history_defaults_to_three_months(monkeypatch):
    monkeypatch.delenv("INGEST_MONTHS", raising=False)
    assert initial_history_months() == 3
    assert initial_history_months({}) == 3


@pytest.mark.parametrize("value,expected", [("1", 1), ("3", 3), ("13", 13), (" 2 ", 2)])
def test_initial_history_accepts_bounded_calendar_months(value, expected):
    assert initial_history_months({"INGEST_MONTHS": value}) == expected


@pytest.mark.parametrize("value", ["", "0", "14", "-1", "1.5", "three", "true"])
def test_initial_history_refuses_invalid_values(value):
    with pytest.raises(ValueError, match="INGEST_MONTHS must be an integer from 1 to 13"):
        initial_history_months({"INGEST_MONTHS": value})
