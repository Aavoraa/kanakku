import { useEffect, useRef } from 'react';

/**
 * One keymap registry for the whole app. Screens push handler maps; the most recently
 * mounted map wins, then earlier ones, then the global map in App. A handler returns
 * false to let the key fall through.
 */
type Handler = (e: KeyboardEvent) => boolean | void;
type KeyMap = Record<string, Handler>;

const stack: { map: React.MutableRefObject<KeyMap> }[] = [];

export function comboOf(e: KeyboardEvent): string {
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && key.length > 1 ? 'Shift+' : ''}${key}`;
}

/** App-wide shortcuts: always checked after every screen-level map. */
let globalMap: React.MutableRefObject<KeyMap> | null = null;

export function dispatchKey(e: KeyboardEvent): boolean {
  const combo = comboOf(e);
  const maps = [...stack.map((s) => s.map).reverse(), ...(globalMap ? [globalMap] : [])];
  for (const m of maps) {
    const h = m.current[combo];
    if (h && h(e) !== false) {
      e.preventDefault();
      return true;
    }
  }
  return false;
}

/**
 * Acts as if `combo` ("F8", "Ctrl+U", "Alt+H") had been pressed, so a click on a shortcut in the key bar does
 * exactly what the key does on the current screen (F8 on a voucher switches it to Sales, Esc asks before discarding).
 */
export function pressKey(combo: string): boolean {
  const parts = combo.split('+');
  const key = parts.pop()!;
  return dispatchKey(new KeyboardEvent('keydown', {
    key, ctrlKey: parts.includes('Ctrl'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), cancelable: true,
  }));
}

export function useGlobalKeys(map: KeyMap) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    globalMap = ref;
    return () => { if (globalMap === ref) globalMap = null; };
  }, []);
}

export function useKeys(map: KeyMap, active = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!active) return;
    const entry = { map: ref };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

export const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
};
