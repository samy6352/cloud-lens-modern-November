/** Categorical series colours, shared by ECharts and the HTML legends beside the charts. */
export const PALETTE = ["#1785a3", "#6787a0", "#b58a42", "#37856f", "#a66874", "#7a7ba1", "#b75d54", "#7b9156", "#4798b4", "#ad794f"];
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

const INK = "#0f172a";
const WHITE = "#ffffff";

function mix(hex: string, toward: string, t: number) {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = parse(hex);
  const b = parse(toward);
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

function ratio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * A chip background and its text colour that meet WCAG AA (4.5:1) for small text.
 * The palette is tuned for fills, and several of its mid-tones miss AA with both white and dark text,
 * so the fill is moved a little toward black (under white text) or white (under dark text) until it passes.
 */
export function chipOn(hex: string): { background: string; color: string } {
  const color = ratio(hex, INK) >= ratio(hex, WHITE) ? INK : WHITE;
  const toward = color === WHITE ? "#000000" : "#ffffff";
  for (let t = 0; t <= 1; t += 0.05) {
    const background = t === 0 ? hex : mix(hex, toward, t);
    if (ratio(background, color) >= 4.5) return { background, color };
  }
  return { background: hex, color };
}