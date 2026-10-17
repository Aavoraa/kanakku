import type { ComplianceItem } from './api';

/**
 * Desktop pop-ups for due dates, through the browser's Notification API. They are shown by this computer's
 * operating system; nothing is sent anywhere. Off until the user switches them on (and the browser asks).
 * They only appear while Kannaku AI is open in a tab.
 */
const ON_KEY = 'kannaku.desktopNotify.v1';
const SHOWN_KEY = 'kannaku.notified.v1';

export const desktopSupported = () => typeof window !== 'undefined' && 'Notification' in window;
export const desktopOn = () => {
  try { return desktopSupported() && Notification.permission === 'granted' && localStorage.getItem(ON_KEY) === '1'; } catch { return false; }
};

/** Asks the browser for permission (it shows its own prompt); true when pop-ups are now on. */
export async function enableDesktop(): Promise<boolean> {
  if (!desktopSupported()) return false;
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  try { localStorage.setItem(ON_KEY, p === 'granted' ? '1' : '0'); } catch { /* storage blocked */ }
  return p === 'granted';
}
export function disableDesktop() {
  try { localStorage.setItem(ON_KEY, '0'); } catch { /* storage blocked */ }
}

const describe = (i: ComplianceItem) => i.status === 'OVERDUE'
  ? `Overdue by ${-i.daysLeft} day${i.daysLeft === -1 ? '' : 's'}`
  : i.daysLeft === 0 ? 'Due today' : `Due in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}`;

/**
 * Pops up what is overdue or due within two days, once a day per item. More than three at once become one summary.
 * `onOpen` runs when a pop-up is clicked.
 */
export function notifyDue(items: ComplianceItem[], companyName: string, today: string, onOpen: () => void) {
  if (!desktopOn()) return;
  let shown: Record<string, string> = {};
  try { shown = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '{}'); } catch { shown = {}; }
  const fresh = items.filter((i) => (i.status === 'OVERDUE' || (i.status === 'DUE_SOON' && i.daysLeft <= 2)) && shown[`${companyName}|${i.key}`] !== today);
  if (!fresh.length) return;
  const pop = (title: string, body: string, tag: string) => {
    try {
      const n = new Notification(title, { body, tag });
      n.onclick = () => { window.focus(); onOpen(); n.close(); };
    } catch { /* blocked by the browser */ }
  };
  if (fresh.length > 3) {
    const overdue = fresh.filter((i) => i.status === 'OVERDUE').length;
    pop(`${companyName}: ${fresh.length} compliance items need attention`,
      `${overdue ? `${overdue} overdue, ` : ''}${fresh.length - overdue} due within two days. Click to open the calendar.`, `kannaku-${companyName}-summary`);
  } else {
    for (const i of fresh) pop(`${i.title} · ${i.periodLabel}`, `${companyName} · ${describe(i)}`, `kannaku-${companyName}-${i.key}`);
  }
  for (const i of fresh) shown[`${companyName}|${i.key}`] = today;
  // Forget entries older than 40 days, so this does not grow for ever.
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 40 * 864e5).toISOString().slice(0, 10);
  const keep = Object.entries(shown).filter(([, d]) => d >= cutoff);
  try { localStorage.setItem(SHOWN_KEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* storage blocked */ }
}

export { describe as dueText };
