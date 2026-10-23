"""A stopped PostgreSQL server must not stop the app from starting; schema setup waits for the database."""
from __future__ import annotations

import importlib
import sys

from app import store


class StoppedStore:
    """Stands in for PostgresStore while the database is stopped."""

    host = "stopped.invalid"
    database = "cloudlens"
    available = False

    def __init__(self, *args, **kwargs):
        pass

    def connect(self):
        if not StoppedStore.available:
            raise ConnectionError("stopped")
        return _Connection()

    def check_readiness(self, *args, **kwargs):
        return False


class _Connection:
    def close(self):
        pass


def _fresh_warehouse_module(monkeypatch):
    monkeypatch.setattr(store, "PostgresStore", StoppedStore)
    monkeypatch.delitem(sys.modules, "app.warehouse", raising=False)
    return importlib.import_module("app.warehouse")


def test_import_survives_a_stopped_database(monkeypatch):
    module = _fresh_warehouse_module(monkeypatch)
    assert module.warehouse._schema_pending is True
    assert module.warehouse.state["status"] == "unavailable"


def test_schema_setup_runs_on_first_connection_after_the_database_returns(monkeypatch):
    module = _fresh_warehouse_module(monkeypatch)
    built = module.warehouse
    runs: list[int] = []
    monkeypatch.setattr(module.Warehouse, "_init_schema", lambda self: runs.append(1))
    monkeypatch.setattr(StoppedStore, "available", True)
    monkeypatch.setattr(built, "_prepare_connection", lambda con, *a, **k: con)
    built.connect()
    assert runs == [1]
    assert built._schema_pending is False
