"""Parquet+Snappy FOCUS 1.0r2 exports -- the format every export CloudLens creates now writes.

Built with pyarrow (independent of the loader), shaped like a real Cost Management run: a
manifest.json naming snappy partitions with exact byte and row counts, and FOCUS 1.0r2 dates,
which carry seconds. Driven through the real `ingest_export`, not a helper beneath it.
"""
from __future__ import annotations

import asyncio
import io
import json
from datetime import UTC, datetime

import httpx
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from tests.test_focus_schedules import ingest, memory, offline_modules  # noqa: F401

SUB = "00000000-0000-0000-0000-00000000000a"
RID = f"/subscriptions/{SUB}/resourcegroups/rg-app/providers/microsoft.compute/virtualmachines/vm-{{}}"


def _table(days: list[int], *, timestamps: bool, rows_per_day: int = 1) -> pa.Table:
    starts, ends, billed, effective, resources = [], [], [], [], []
    for day in days:
        for n in range(rows_per_day):
            start = datetime(2026, 8, day, tzinfo=UTC)
            end = datetime(2026, 8, day + 1, tzinfo=UTC) if day < 31 else datetime(2026, 9, 1, tzinfo=UTC)
            starts.append(start if timestamps else start.strftime("%Y-%m-%dT%H:%M:%SZ"))
            ends.append(end if timestamps else end.strftime("%Y-%m-%dT%H:%M:%SZ"))
            billed.append(1.25 + n)
            effective.append(1.0 + n)
            resources.append(RID.format(n))
    count = len(starts)
    date_type = pa.timestamp("s", tz="UTC") if timestamps else pa.string()
    return pa.table({
        "BilledCost": pa.array(billed, pa.float64()),
        "EffectiveCost": pa.array(effective, pa.float64()),
        "ListCost": pa.array([1.5] * count, pa.float64()),
        "ContractedCost": pa.array([1.25] * count, pa.float64()),
        "BillingCurrency": ["INR"] * count,
        "ChargePeriodStart": pa.array(starts, date_type),
        "ChargePeriodEnd": pa.array(ends, date_type),
        "ChargeCategory": ["Usage"] * count,
        "SubAccountId": [f"/subscriptions/{SUB}"] * count,
        "SubAccountName": ["Alpha"] * count,
        "ResourceId": resources,
        "ResourceName": [None] * count,
        "ServiceName": ["Virtual Machines"] * count,
        "RegionName": ["Central India"] * count,
        "PricingQuantity": pa.array([24.0] * count, pa.float64()),
        "PricingUnit": ["1 Hour"] * count,
        "Tags": ['{"env":"prod"}'] * count,
        "x_ResourceGroupName": ["rg-app"] * count,
    })


def _snappy(table: pa.Table) -> bytes:
    sink = io.BytesIO()
    pq.write_table(table, sink, compression="snappy")
    return sink.getvalue()


def focus_run(run_id: str, partitions: list[pa.Table], *, end: str = "2026-08-31",
              submitted: str = "2026-09-02T04:00:00Z") -> dict[str, bytes]:
    """One run the way Cost Management writes it: partitions plus a manifest that counts them."""
    base = f"focus/{SUB}/owned/20260801-20260831/{run_id}"
    files = {f"{base}/part_{i}_0001.snappy.parquet": _snappy(t) for i, t in enumerate(partitions)}
    manifest = {
        "manifestVersion": "2024-04-01",
        "byteCount": sum(len(v) for v in files.values()),
        "blobCount": len(files),
        "dataRowCount": sum(t.num_rows for t in partitions),
        "exportConfig": {"exportName": "owned", "type": "FocusCost", "dataVersion": "1.0r2",
                         "apiVersion": "2025-03-01", "timeFrame": "Custom", "granularity": "Daily"},
        "deliveryConfig": {"partitionData": True, "dataOverwriteBehavior": "CreateNewReport",
                           "fileFormat": "Parquet", "compressionMode": "Snappy"},
        "runInfo": {"executionType": "OnDemand", "submittedTime": submitted, "runId": run_id,
                    "startDate": "2026-08-01T00:00:00Z", "endDate": f"{end}T00:00:00Z"},
        "blobs": [{"blobName": name, "byteCount": len(raw), "dataRowCount": t.num_rows}
                  for (name, raw), t in zip(files.items(), partitions, strict=True)],
    }
    return {f"{base}/manifest.json": json.dumps(manifest).encode(), **files}


@pytest.mark.parametrize("timestamps", [True, False], ids=["timestamp-typed", "iso-with-seconds"])
def test_snappy_focus_run_loads_end_to_end_through_the_exact_run_path(monkeypatch, memory, timestamps):  # noqa: F811
    blobs = focus_run("run-1", [_table([1, 2, 3], timestamps=timestamps),
                                _table([30, 31], timestamps=timestamps)])
    result, reader = ingest(monkeypatch, blobs, export_name="owned", subscription_id=SUB, scope=[SUB],
                            metric="FocusCost", run_identity=("run-1", "2026-09-02T04:00:00Z"),
                            requested_window=("2026-08-01", "2026-08-31"))
    assert result["rows"] == 5 and result["runs"] == ["run-1"]
    assert sorted(memory.snapshot()) == [(SUB, f"2026-08-{d:02d}", 1.25) for d in (1, 2, 3, 30, 31)]
    assert sum(name.endswith(".snappy.parquet") for name in reader.fetched) == 2


def test_parquet_timestamp_cells_are_spelled_as_iso_like_csv():
    from app import exports

    header, rows = exports._rows_from_parquet(_snappy(_table([5], timestamps=True)))
    row = dict(zip(header, next(iter(rows)), strict=True))
    assert row["ChargePeriodStart"] == "2026-08-05T00:00:00Z"
    assert row["ChargePeriodEnd"] == "2026-08-06T00:00:00Z"
    assert row["ResourceName"] == ""


def test_parquet_is_bounded_per_batch_not_by_its_whole_decoded_size(monkeypatch):
    """A real partition decodes to far more than 64 MB while holding one batch at a time."""
    from app import exports

    raw = _snappy(_table(list(range(1, 29)), timestamps=True, rows_per_day=200))
    reader = pq.ParquetFile(io.BytesIO(raw))
    batches = list(reader.iter_batches(batch_size=1024))
    largest, total = max(b.nbytes for b in batches), sum(b.nbytes for b in batches)
    assert total > 2 * largest
    monkeypatch.setattr(exports, "EXPORT_MAX_BYTES", largest)
    _header, rows = exports._rows_from_parquet(raw)
    assert sum(1 for _ in rows) == 28 * 200
    # A single batch larger than the bound is still refused: that is memory actually held.
    monkeypatch.setattr(exports, "EXPORT_MAX_BYTES", largest - 1)
    with pytest.raises(exports.ExportError, match="memory safety"):
        list(exports._rows_from_parquet(raw)[1])
    # So is a file beyond the partition bound Azure itself guarantees.
    monkeypatch.setattr(exports, "EXPORT_MAX_PARQUET_BYTES", len(raw) - 1)
    with pytest.raises(exports.ExportError, match="memory safety"):
        exports._rows_from_parquet(raw)


def test_download_bound_follows_the_format(monkeypatch):
    from app import exports

    payload = b"x" * 5000
    original = httpx.AsyncClient
    monkeypatch.setattr(exports.httpx, "AsyncClient", lambda **kw: original(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=payload)), **kw))
    monkeypatch.setattr(exports, "EXPORT_MAX_BYTES", 1000)
    monkeypatch.setattr(exports, "EXPORT_MAX_PARQUET_BYTES", 10_000)
    reader = exports.BlobReader("offline", "focus-exports", sas="sv=offline")
    assert asyncio.run(reader.get("run/part_0_0001.snappy.parquet")) == payload
    for csv_name in ("run/part_0_0001.csv", "run/part_0_0001.csv.gz", "run/manifest.json"):
        with pytest.raises(exports.ExportError, match="memory safety"):
            asyncio.run(reader.get(csv_name))
    monkeypatch.setattr(exports, "EXPORT_MAX_PARQUET_BYTES", 4999)
    with pytest.raises(exports.ExportError, match="memory safety"):
        asyncio.run(reader.get("run/part_0_0001.snappy.parquet"))
