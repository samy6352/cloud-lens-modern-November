import asyncio

from app import governance


def test_networking_requires_explicit_sku_support_in_the_nic_scope(monkeypatch):
    seen = []

    def nic(name, subscription="sub-a", region="eastus", sku="Standard_D4", enabled=False):
        return {
            "nicName": name, "nicId": f"/nic/{name}", "vmId": f"/vm/{name}",
            "subscriptionId": subscription, "location": region, "vmSize": sku, "accel": enabled,
        }

    async def inventory(*_args, **_kwargs):
        return [
            nic("confirmed"), nic("unsupported", sku="Standard_D2"),
            nic("other-region", region="westus"), nic("other-sub", subscription="sub-b"),
            nic("already-enabled", enabled=True), nic("unknown-config", enabled=None),
        ]

    async def sku_pages(url, *, params):
        seen.append((url, params["$filter"]))
        if "/sub-b/" in url:
            raise RuntimeError("Not authorized")
        if params["$filter"] == "location eq 'westus'":
            return []
        return [
            {"resourceType": "virtualMachines", "name": name, "capabilities": [
                {"name": "AcceleratedNetworkingEnabled", "value": flag}]}
            for name, flag in [("standard_d4", "True"), ("standard_d2", "False")]
        ]

    monkeypatch.setattr(governance, "_arg", inventory)
    monkeypatch.setattr(governance, "arm_pages", sku_pages)
    result = asyncio.run(governance.accelerated_networking(["sub-a", "sub-b"]))
    assert [row["nicName"] for row in result["eligible"]] == ["confirmed"]
    assert result["eligible_count"] == 1
    assert result["enabled"] == result["not_supported"] == 1
    assert result["unverified"] == 3
    assert len(seen) == 3
