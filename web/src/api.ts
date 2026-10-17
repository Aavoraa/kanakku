/** Thin fetch wrapper. All money fields ending in "Minor" are paise as strings. */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: unknown) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {
    // Not JSON: a proxy error page, or the server stopped mid-request.
    throw new ApiError(res.status, 'BAD_RESPONSE', res.ok ? 'The server sent an unexpected reply.' : `The server is not responding (${res.status} ${res.statusText}). Is it still running?`, null);
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/v1/auth/')) for (const fn of unauthListeners) fn();
    throw new ApiError(res.status, data?.code ?? 'HTTP', data?.message ?? res.statusText, data?.details ?? null);
  }
  return data as T;
}

const unauthListeners = new Set<() => void>();
/** Called when any API call comes back 401 (session expired or logged out elsewhere). Returns an unsubscribe. */
export function onUnauthenticated(fn: () => void) {
  unauthListeners.add(fn);
  return () => { unauthListeners.delete(fn); };
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', url, body, headers),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

let companyId = '';
export const setCompany = (id: string) => { companyId = id; };
export const c = (path: string) => `/api/v1/companies/${companyId}${path}`;

export interface Status { app: string; aiEnabled: boolean; model: string; today: string; states: Record<string, string>; hasUsers: boolean; unclaimed: string[] }
export interface User { id: string; email: string; name: string; phone: string | null }
export interface Company { id: string; name: string; gstin: string | null; stateCode: string; booksFrom: string; lockDate: string | null; fyStartMonth: number; voiceLimitMinor: string; roundInvoice: boolean; role: string; autoPost?: boolean; autoPostLimitMinor?: string }
export interface Ledger { id: string; name: string; groupName: string; groupId: string; path: string; nature: string; systemCode: string | null; counterpartyId: string | null; billWise: boolean; taxComponent: string | null; isCashBank: boolean; balanceMinor: string; isActive?: boolean }
export interface Party { id: string; name: string; gstin: string | null; stateCode: string | null; city: string | null; phone: string | null; creditDays: number | null; status: string; ledgerId: string; groupName: string; kind: 'CUSTOMER' | 'SUPPLIER' | 'OTHER'; balanceMinor: string; regType?: string }
export interface Item { id: string; name: string; hsnSac: string | null; gstRatePpm: number | null; valuation: string; uom: string; uomId: string; qtyOnHand: string; isActive?: boolean; allowNegative?: boolean }
export interface Group { id: string; parentId: string | null; name: string; nature: string; systemCode: string | null; path: string }
export interface Uom { id: string; symbol: string; uqc: string }

export type VoucherType = 'SALES' | 'PURCHASE' | 'PAYMENT' | 'RECEIPT' | 'JOURNAL' | 'CONTRA' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

export interface ItemLineInput {
  itemId?: string | null; ledgerId?: string | null; description?: string | null; qty?: string | null; rate?: string | null;
  amount: string; gstRate: string; hsnSac?: string | null; itcEligible?: boolean;
}
export interface EntryLineInput { ledgerId: string; side: 'DR' | 'CR'; amount: string; billRef?: string | null }
export interface VoucherInput {
  voucherType: VoucherType | 'OPENING';
  date: string;
  counterpartyId?: string | null;
  paymentMode?: 'CREDIT' | 'CASH' | 'BANK';
  bankLedgerId?: string | null;
  partyRefNo?: string | null;
  partyRefDate?: string | null;
  originalRef?: string | null;
  dueDate?: string | null;
  placeOfSupply?: string | null;
  reverseCharge?: boolean;
  pricesIncludeTax?: boolean;
  items?: ItemLineInput[];
  entries?: EntryLineInput[];
  narration?: string | null;
  confirmWarnings?: boolean;
}

export interface Preview {
  totalMinor: string; taxableMinor: string; taxMinor: string; roundOffMinor: string;
  placeOfSupply: string | null; intraState: boolean | null;
  warnings: { code: string; message: string }[];
  entries: { ledgerId: string; ledgerName: string; amountMinor: string; bill: { ref: string; type: string } | null }[];
  taxes: { component: string; ratePpm: number; taxableMinor: string; taxMinor: string; ledgerName: string; itemLineNo: number }[];
}

export interface Posted { id: string; voucherNo: string; voucherType: string; date: string; totalMinor: string; alreadyPosted: boolean }

export interface ComplianceSettings {
  gst: boolean; gstFrequency: 'MONTHLY' | 'QUARTERLY'; gstAnnual: boolean; incomeTax: boolean; taxAudit: boolean; advanceTax: boolean; tds: boolean; remindDays: number;
}
export type ComplianceStatus = 'DONE' | 'OVERDUE' | 'DUE_SOON' | 'UPCOMING';
export interface ComplianceItem {
  key: string; kind: string; category: 'GST' | 'TDS' | 'INCOME_TAX' | 'TASK' | 'ASSET' | 'CASH'; title: string; link?: string; periodLabel: string; periodFrom: string; periodTo: string;
  dueDate: string; due: string; extended: boolean; status: ComplianceStatus; daysLeft: number; remindDays: number;
  estimateMinor: string | null; taskId?: string; taskCategory?: string; notes?: string | null;
  record: { doneOn: string | null; reference: string | null; amountMinor: string | null; notes: string | null } | null;
}
export interface ComplianceTask { id: string; title: string; category: string; firstDue: string; repeat: string; remindDays: number; notes: string | null }
export interface ComplianceAlerts { today: string; overdue: number; dueSoon: number; items: ComplianceItem[] }

export interface TreeNode { kind: 'group' | 'ledger' | 'virtual'; id: string; name: string; amountMinor: string; children: TreeNode[] }
