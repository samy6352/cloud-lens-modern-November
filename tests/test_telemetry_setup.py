"""Telemetry is configured only when APPLICATIONINSIGHTS_CONNECTION_STRING is set."""
from __future__ import annotations

import sys
from types import ModuleType
from unittest.mock import Mock

import pytest


@pytest.fixture
def sdk(monkeypatch):
    configure = Mock()
    monitor = ModuleType("azure.monitor")
    opentelemetry = ModuleType("azure.monitor.opentelemetry")
    opentelemetry.configure_azure_monitor = configure
    monkeypatch.setitem(sys.modules, "azure.monitor", monitor)
    monkeypatch.setitem(sys.modules, "azure.monitor.opentelemetry", opentelemetry)
    return configure


def test_no_connection_string_means_no_telemetry_setup(monkeypatch, sdk):
    from app import main

    monkeypatch.delenv("APPLICATIONINSIGHTS_CONNECTION_STRING", raising=False)
    main._configure_telemetry()
    sdk.assert_not_called()


def test_blank_connection_string_is_ignored(monkeypatch, sdk):
    from app import main

    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", "   ")
    main._configure_telemetry()
    sdk.assert_not_called()


def test_connection_string_configures_azure_monitor(monkeypatch, sdk):
    from app import main

    connection = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.invalid/"
    monkeypatch.setenv("APPLICATIONINSIGHTS_CONNECTION_STRING", connection)
    main._configure_telemetry()
    sdk.assert_called_once()
    kwargs = sdk.call_args.kwargs
    assert kwargs["connection_string"] == connection
    assert kwargs["credential"] is not None
