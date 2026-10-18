// The company's colour theme: the accent on buttons, tabs and highlights. One of the ready-made colours,
// or the company's own (e.g. from its logo), made lighter for dark screens and darker for light screens
// so text on it always stays readable (WCAG AA contrast). Shared by the server and the app.

export const ACCENT_PRESETS = {
  orange: { label: 'ZSP orange', dark: '#E8701A', light: '#C2570B' },
  blue: { label: 'Ocean blue', dark: '#4C9BEA', light: '#1D63B3' },
  green: { label: 'Forest green', dark: '#4CB874', light: '#22764A' },
  teal: { label: 'Teal', dark: '#2CC4B0', light: '#0F766E' },
  sky: { label: 'Sky blue', dark: '#38BDF8', light: '#0369A1' },
  indigo: { label: 'Indigo', dark: '#818CF8', light: '#4338CA' },
  purple: { label: 'Royal purple', dark: '#A78BFA', light: '#6D28D9' },
  pink: { label: 'Berry pink', dark: '#F472B6', light: '#BE185D' },
  red: { label: 'Fire red', dark: '#EF5F5A', light: '#C0302B' },
  copper: { label: 'Copper', dark: '#D98E52', light: '#9A4A12' },
  yellow: { label: 'Sun yellow', dark: '#F2C230', light: '#866200' },
  lime: { label: 'Lime', dark: '#9CCB3B', light: '#4D7C0F' },
  slate: { label: 'Steel grey', dark: '#9AA8BA', light: '#4A5568' },
} as const;
export type AccentPreset = keyof typeof ACCENT_PRESETS;
export const ACCENT_KEYS = Object.keys(ACCENT_PRESETS) as AccentPreset[];
/** A preset's name, or the company's own colour as #rrggbb. */
export type Accent = AccentPreset | `#${string}`;

const HEX = /^#[0-9a-f]{6}$/i;
export const isAccent = (v: unknown): v is Accent => typeof v === 'string' && (v in ACCENT_PRESETS || HEX.test(v));

const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const hex = (c: number[]) => '#' + c.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
function lum(h: string) {
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(h).map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function toHsl([r, g, b]: number[]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl([h, s, l]: number[]) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const t = (x: number) => { x = (x + 1) % 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
  return [t(h + 1 / 3), t(h), t(h - 1 / 3)];
}
/** Lighter (dark screens: dark text on it) or darker (light screens: white text on it) until it reads well. */
function fit(color: string, against: string, min: number, lighter: boolean) {
  const [h, s, l0] = toHsl(rgb(color));
  let l = l0;
  for (let i = 0; i < 100 && contrast(hex(fromHsl([h, s, l])), against) < min; i++) l = lighter ? Math.min(1, l + 0.01) : Math.max(0, l - 0.01);
  return hex(fromHsl([h, s, l]));
}

export const DARK_TEXT = '#14161A';
/** The colour for dark and for light screens. */
export function accentColours(a: Accent): { label: string; dark: string; light: string } {
  if (a in ACCENT_PRESETS) return ACCENT_PRESETS[a as AccentPreset];
  if (!HEX.test(a)) return ACCENT_PRESETS.orange;
  return { label: 'Our own colour', dark: fit(a, DARK_TEXT, 5, true), light: fit(a, '#FFFFFF', 4.6, false) };
}
