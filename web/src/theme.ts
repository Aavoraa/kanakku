/** Light, dark, or follow the computer. Remembered per browser; applied before the first paint (main.tsx). */
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'kannaku.theme';

export function loadTheme(): Theme {
  try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage blocked */ }
}
