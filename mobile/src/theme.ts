// High contrast for sunlight, large targets for gloved hands. Dark or light is each person's choice on
// their device; the colour theme (a ready-made colour or the company's own) is the company's, chosen by the director.
import { accentColours, isAccent, type Accent } from '../../server/src/core/themes.ts';
export type Mode = 'dark' | 'light';
export type { Accent };

const DARK = {
  bg: '#17191C', panel: '#22252A', panel2: '#2C3036', line: '#3A3F46', text: '#F3F1EC', quiet: '#B9B4AA',
  good: '#3FB57A', goodBg: '#1E3A2C', warn: '#F2B544', warnBg: '#3D3220', bad: '#F0645A', badBg: '#432624', info: '#6FA4E8', infoBg: '#1F2E42',
};
const LIGHT: typeof DARK = {
  bg: '#F3F1EC', panel: '#FFFFFF', panel2: '#E9E5DD', line: '#CFC9BE', text: '#1B1D20', quiet: '#5B574F',
  good: '#1D7F4E', goodBg: '#DCF0E4', warn: '#8A5A00', warnBg: '#FBEBC8', bad: '#C2362C', badBg: '#FADDDA', info: '#245FA8', infoBg: '#DCE8F7',
};
/** The colour themes (the accent colour on buttons, tabs and highlights): server/src/core/themes.ts. */
export { ACCENT_KEYS, ACCENT_PRESETS, accentColours } from '../../server/src/core/themes.ts';

let mode: Mode = 'dark';
let accent: Accent = 'orange';
const accentOf = (m: Mode, a: Accent) => ({ accent: accentColours(a)[m], accentText: m === 'dark' ? '#14161A' : '#FFFFFF' });

/** The colours in use now. Read them while drawing (not once at start), so a change shows at once. */
export const C = { ...DARK, ...accentOf(mode, accent) };

const listeners = new Set<() => void>();
export const onThemeChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const themeNow = () => ({ mode, accent });
export function setTheme(next: { mode?: Mode; accent?: Accent }) {
  const m = next.mode ?? mode, a = next.accent && isAccent(next.accent) ? next.accent : accent;
  if (m === mode && a === accent) return;
  mode = m; accent = a;
  Object.assign(C, mode === 'light' ? LIGHT : DARK, accentOf(mode, accent));
  listeners.forEach(f => f());
}

export const S = {
  gap: 12,
  pad: 16,
  radius: 10,
  touch: 56,
  body: 17,
  small: 14,
  title: 22,
  big: 28,
};
