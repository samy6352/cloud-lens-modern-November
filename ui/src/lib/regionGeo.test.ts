import { describe, expect, it } from "vitest";
import { placeRegions, project, regionDisplayName, resolveRegion } from "./regionGeo";

describe("resolveRegion", () => {
  it("resolves display, ARM and meter-style names to the same region", () => {
    expect(resolveRegion("Central India")).toBe("centralindia");
    expect(resolveRegion("centralindia")).toBe("centralindia");
    expect(resolveRegion("in central")).toBe("centralindia");
    expect(resolveRegion("us east 2")).toBe("eastus2");
    expect(resolveRegion("East US 2")).toBe("eastus2");
    expect(resolveRegion("us north central")).toBe("northcentralus");
    expect(resolveRegion("se central")).toBe("swedencentral");
    expect(resolveRegion("ap southeast")).toBe("southeastasia");
    expect(resolveRegion("ap east")).toBe("eastasia");
    expect(resolveRegion("in south central")).toBe("southcentralindia");
    expect(resolveRegion("uk south")).toBe("uksouth");
    expect(resolveRegion("au central 2")).toBe("australiacentral2");
  });

  it("never places non-locations on the map", () => {
    for (const name of ["Global", "unassigned", "", "\uFFFD", "Zone 1", null, undefined]) expect(resolveRegion(name)).toBeNull();
  });
});

describe("placeRegions", () => {
  it("keeps unmappable spend separate instead of dropping it", () => {
    const { placed, unplaced } = placeRegions([
      { name: "Central India", cost: 10 },
      { name: "Global", cost: 5 },
    ]);
    expect(placed.map((p) => p.arm)).toEqual(["centralindia"]);
    expect(unplaced.map((r) => r.name)).toEqual(["Global"]);
  });

  it("projects into the shared 2000x760 map space", () => {
    expect(project(80, -180)).toEqual([0, 0]);
    expect(project(-56, 180)).toEqual([2000, 760]);
  });
});

describe("regionDisplayName", () => {
  it("turns ARM names into Azure display names", () => {
    expect(regionDisplayName("centralindia")).toBe("Central India");
    expect(regionDisplayName("eastus2")).toBe("East US 2");
    expect(regionDisplayName("southeastasia")).toBe("Southeast Asia");
    expect(regionDisplayName("southafricanorth")).toBe("South Africa North");
    expect(regionDisplayName("southcentralus")).toBe("South Central US");
    expect(regionDisplayName("swedencentral")).toBe("Sweden Central");
    expect(regionDisplayName("zzz")).toBeNull();
  });
});
