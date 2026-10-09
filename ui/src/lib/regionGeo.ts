/**
 * Azure billing locations to map coordinates.
 *
 * Cost exports name regions inconsistently: "Central India", "centralindia" and the meter style
 * "in central" all mean the same datacentre. Everything resolves to the ARM name first; anything
 * that is not a place (Global, Unassigned, garbled) is reported separately rather than invented
 * onto the map. Coordinates match web/assets/regionmap.js.
 */
export const REGION_COORDS: Record<string, [lat: number, lon: number]> = {
  eastus: [37.37, -79.82], eastus2: [36.67, -78.39], eastus3: [32.78, -96.8],
  centralus: [41.59, -93.62], northcentralus: [41.88, -87.62],
  southcentralus: [29.42, -98.49], westcentralus: [40.89, -110.23],
  westus: [37.78, -122.42], westus2: [47.23, -119.85], westus3: [33.45, -112.07],
  canadacentral: [43.65, -79.38], canadaeast: [46.82, -71.21],
  brazilsouth: [-23.55, -46.63], brazilsoutheast: [-22.91, -43.17],
  mexicocentral: [20.59, -100.39],
  northeurope: [53.35, -6.26], westeurope: [52.37, 4.9],
  uksouth: [50.94, -0.8], ukwest: [53.43, -3.08],
  francecentral: [46.37, 2.37], francesouth: [43.82, 2.19],
  germanywestcentral: [50.11, 8.68], germanynorth: [53.07, 8.81],
  switzerlandnorth: [47.45, 8.56], switzerlandwest: [46.2, 6.14],
  norwayeast: [59.91, 10.75], norwaywest: [58.97, 5.73],
  swedencentral: [60.67, 17.14], swedensouth: [55.6, 13.0], polandcentral: [52.23, 21.01],
  italynorth: [45.47, 9.18], spaincentral: [40.42, -3.7], austriaeast: [48.21, 16.37],
  uaenorth: [25.27, 55.3], uaecentral: [24.47, 54.37],
  qatarcentral: [25.29, 51.53], israelcentral: [31.77, 35.21],
  southafricanorth: [-25.73, 28.22], southafricawest: [-33.91, 18.42],
  centralindia: [18.52, 73.86], southindia: [12.97, 80.16], westindia: [19.09, 72.87],
  southcentralindia: [17.39, 78.49],
  jioindiawest: [22.47, 70.06], jioindiacentral: [21.15, 79.09],
  eastasia: [22.27, 114.19], southeastasia: [1.28, 103.83],
  japaneast: [35.68, 139.77], japanwest: [34.69, 135.5],
  koreacentral: [37.57, 126.98], koreasouth: [35.18, 129.08],
  australiaeast: [-33.86, 151.21], australiasoutheast: [-37.81, 144.96],
  australiacentral: [-35.31, 149.12], australiacentral2: [-35.31, 149.12],
  newzealandnorth: [-36.85, 174.76],
  chinanorth: [39.9, 116.41], chinaeast: [31.23, 121.47],
  indonesiacentral: [-6.21, 106.85], malaysiawest: [3.14, 101.69],
  taiwannorth: [25.03, 121.57], chilecentral: [-33.45, -70.67],
};

/** Two-letter geography prefixes used by meter-style names such as "us east 2" or "in central". */
const GEO_PREFIX: Record<string, string> = {
  us: "us", in: "india", se: "sweden", ap: "asia", eu: "europe", uk: "uk", ca: "canada",
  br: "brazil", au: "australia", jp: "japan", kr: "korea", de: "germany", fr: "france",
  ch: "switzerland", no: "norway", za: "southafrica", ae: "uae", qa: "qatar", il: "israel",
  pl: "poland", it: "italy", es: "spain", mx: "mexico", nz: "newzealand", tw: "taiwan",
  id: "indonesia", my: "malaysia", at: "austria", cl: "chile",
};

const NON_PLACES = new Set(["", "global", "unassigned", "unknown", "n/a", "na", "all regions", "intercontinental", "zone 1", "zone 2", "zone 3"]);

/** ARM region name for a billing location, or null when it is not a mappable place. */
export function resolveRegion(name: string | null | undefined): string | null {
  const raw = String(name ?? "").trim().toLowerCase();
  if (NON_PLACES.has(raw)) return null;
  const compact = raw.replace(/[^a-z0-9]/g, "");
  if (compact in REGION_COORDS) return compact;
  const words = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const [prefix, ...rest] = words;
  const geo = prefix ? GEO_PREFIX[prefix] : undefined;
  if (geo && rest.length) {
    const area = rest.join("");
    // ARM puts the geography last for some regions (centralindia) and first for others (swedencentral).
    for (const candidate of [area + geo, geo + area]) if (candidate in REGION_COORDS) return candidate;
    // "us east 2" -> "eastus2": numbered regions keep their digit after the geography.
    const last = rest[rest.length - 1]!;
    if (/^\d+$/.test(last)) {
      const base = rest.slice(0, -1).join("");
      for (const candidate of [base + geo + last, geo + base + last]) if (candidate in REGION_COORDS) return candidate;
    }
  }
  return null;
}

const WORDS: Record<string, string> = {
  southafrica: "South Africa", newzealand: "New Zealand", switzerland: "Switzerland", australia: "Australia",
  indonesia: "Indonesia", southeast: "Southeast", malaysia: "Malaysia", germany: "Germany", central: "Central",
  austria: "Austria", canada: "Canada", brazil: "Brazil", mexico: "Mexico", europe: "Europe", france: "France",
  norway: "Norway", sweden: "Sweden", poland: "Poland", taiwan: "Taiwan", israel: "Israel", italy: "Italy",
  spain: "Spain", qatar: "Qatar", india: "India", japan: "Japan", korea: "Korea", china: "China", chile: "Chile",
  north: "North", south: "South", asia: "Asia", east: "East", west: "West", uae: "UAE", jio: "Jio", us: "US", uk: "UK",
};
const VOCAB = Object.keys(WORDS).sort((a, b) => b.length - a.length);

/** "southcentralindia" -> "South Central India"; null when the ARM name cannot be segmented. */
export function regionDisplayName(arm: string): string | null {
  const parts: string[] = [];
  let rest = arm;
  while (rest) {
    const digits = /^\d+/.exec(rest);
    if (digits) {
      parts.push(digits[0]);
      rest = rest.slice(digits[0].length);
      continue;
    }
    const word = VOCAB.find((w) => rest.startsWith(w));
    if (!word) return null;
    parts.push(WORDS[word]!);
    rest = rest.slice(word.length);
  }
  return parts.join(" ");
}

export const MAP_W = 2000;
export const MAP_H = 760;
const LAT_TOP = 80;
const LAT_BOTTOM = -56;

/** Equirectangular projection into the 2000x760 world SVG from tools/build_worldmap.py. */
export function project(lat: number, lon: number): [number, number] {
  return [((lon + 180) / 360) * MAP_W, ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * MAP_H];
}

export interface PlacedRegion<T> {
  row: T;
  arm: string;
  x: number;
  y: number;
}

/** Split rows into those with a location on the map and those that are not places. */
export function placeRegions<T extends { name: string; label?: string }>(rows: T[]) {
  const placed: PlacedRegion<T>[] = [];
  const unplaced: T[] = [];
  for (const row of rows) {
    const arm = resolveRegion(row.label ?? row.name);
    const coords = arm ? REGION_COORDS[arm] : undefined;
    if (arm && coords) {
      const [x, y] = project(coords[0], coords[1]);
      placed.push({ row, arm, x, y });
    } else unplaced.push(row);
  }
  return { placed, unplaced };
}
