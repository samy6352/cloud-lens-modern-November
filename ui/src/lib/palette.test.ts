import { describe, expect, it } from "vitest";
import { chipOn, PALETTE } from "./palette";

function channel(v: number) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("chipOn", () => {
  it("gives every palette colour a chip that meets WCAG AA for small text", () => {
    for (const colour of PALETTE) {
      const chip = chipOn(colour);
      expect(contrast(chip.background, chip.color)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses dark text on light fills and white on dark ones, and leaves a passing fill unchanged", () => {
    expect(chipOn("#f59e0b").color).toBe("#0f172a");
    expect(chipOn("#4338ca")).toEqual({ background: "#4338ca", color: "#ffffff" });
  });
});