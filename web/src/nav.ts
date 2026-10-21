import type { Route } from './state';
import type { IconName } from './components/Icon';

/** One place for where everything lives: the sidebar, the Ctrl+K palette and the Home letter keys all read this. */
export interface NavItem { label: string; route: Route; icon: IconName; key?: string; badge?: 'documents' | 'alerts' }
export interface NavGroup { title: string | null; items: NavItem[] }

export const NAV: NavGroup[] = [
  { title: null, items: [{ label: 'Home', route: { screen: 'gateway' }, icon: 'home', key: 'Alt+H' }] },
  {
    title: 'Transactions', items: [
      { label: 'Sales', route: { screen: 'voucher', params: { type: 'SALES' } }, icon: 'sales', key: 'F8' },
      { label: 'Purchase', route: { screen: 'voucher', params: { type: 'PURCHASE' } }, icon: 'purchase', key: 'F9' },
      { label: 'Receipt', route: { screen: 'voucher', params: { type: 'RECEIPT' } }, icon: 'receipt', key: 'F6' },
      { label: 'Payment', route: { screen: 'voucher', params: { type: 'PAYMENT' } }, icon: 'payment', key: 'F5' },
      { label: 'Journal', route: { screen: 'voucher', params: { type: 'JOURNAL' } }, icon: 'journal', key: 'F7' },
      { label: 'Day Book', route: { screen: 'daybook' }, icon: 'daybook', key: 'D' },
      { label: 'Documents', route: { screen: 'review' }, icon: 'upload', key: 'R', badge: 'documents' },
      { label: 'Petty cash', route: { screen: 'petty-cash' }, icon: 'petty', key: 'E' },
    ],
  },
  {
    title: 'Reports', items: [
      { label: 'Trial Balance', route: { screen: 'tb' }, icon: 'scale', key: 'T' },
      { label: 'Profit & Loss', route: { screen: 'pl' }, icon: 'trend', key: 'P' },
      { label: 'Balance Sheet', route: { screen: 'bs' }, icon: 'building', key: 'B' },
      { label: 'Receivables', route: { screen: 'ageing', params: { side: 'receivable' } }, icon: 'arrowIn', key: 'A' },
      { label: 'Payables', route: { screen: 'ageing', params: { side: 'payable' } }, icon: 'arrowOut', key: 'Y' },
      { label: 'Ledger', route: { screen: 'ledger' }, icon: 'ledger', key: 'L' },
      { label: 'Stock', route: { screen: 'stock' }, icon: 'box', key: 'S' },
    ],
  },
  {
    title: 'GST & compliance', items: [
      { label: 'GST Summary', route: { screen: 'gst' }, icon: 'percent', key: 'G' },
      { label: 'Compliance calendar', route: { screen: 'compliance' }, icon: 'calendar', key: 'C', badge: 'alerts' },
    ],
  },
  {
    title: 'Masters & tools', items: [
      { label: 'Masters', route: { screen: 'masters' }, icon: 'users', key: 'M' },
      { label: 'Assets & upkeep', route: { screen: 'assets' }, icon: 'tool', key: 'F' },
      { label: 'Upkeep', route: { screen: 'upkeep' }, icon: 'shield', key: 'U' },
      { label: 'Settings', route: { screen: 'settings' }, icon: 'settings', key: 'O' },
    ],
  },
];

/** Single letters that open a page from Home (as on the old Gateway). */
export const LETTER_KEYS = NAV.flatMap((g) => g.items).filter((i) => i.key && /^[A-Z]$/.test(i.key));

/** Is this nav item the page being shown? (Vouchers match on their type too.) */
export function isActive(item: NavItem, route: Route): boolean {
  if (item.route.screen !== route.screen) {
    return item.route.screen === 'review' && route.screen === 'review-doc';
  }
  if (route.screen === 'voucher') return (route.params?.type ?? route.params?.input?.voucherType) === item.route.params?.type;
  if (route.screen === 'ageing') return (route.params?.side ?? 'receivable') === item.route.params?.side;
  return true;
}
