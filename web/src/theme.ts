/** Max (maximalist), light, dark, or follow the computer. Remembered per browser; applied before the first paint (main.tsx).
 * Max until someone picks another look. The choice is kept under a new name: the old one was written on every visit,
 * so it held "light" for everyone, chosen or not. */
export type Theme = 'system' | 'light' | 'dark' | 'max';
const KEY = 'kannaku.look';

export function loadTheme(): Theme {
  try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' || t === 'system' ? t : 'max'; } catch { return 'max'; }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage blocked */ }
}
