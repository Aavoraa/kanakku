/** Light, dark, or follow the computer. Remembered per browser; applied before the first paint (main.tsx).
 * Dark (black and gold) until someone picks otherwise. */
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'kannaku.theme';

export function loadTheme(): Theme {
  try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'system' ? t : 'dark'; } catch { return 'dark'; }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage blocked */ }
}
