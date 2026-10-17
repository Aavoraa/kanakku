import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { many, maybeOne, one } from '../db/client';
import { config } from '../config';
import { AppError, invalid, notFound } from '../lib/errors';
import { addDays, daysBetween, fyStart, todayIST } from '../lib/dates';
import { complianceAlerts, complianceItems, complianceSettings, createTask, deleteTask, listTasks, saveRecord, updateComplianceSettings } from '../compliance/service';
import { STATES, isValidGstin } from '../lib/gstin';
import { toMinor } from '../lib/money';
import { createGroup, createItem, createLedger, createParty, listGroups, setOpeningBalance } from '../ledger/masters';
import { alterVoucher, correctionNote, postVoucher, previewVoucher, reverseVoucher, verifyChain, type Source } from '../ledger/post';
import { balanceSheet, profitAndLoss, trialBalance } from '../reports/financials';
import { ageing, daybook, ledgerStatement, openBills, voucherDetail } from '../reports/registers';
import { gstSummary } from '../reports/gst';
import { dashboard } from '../reports/dashboard';
import { stockAsOf } from '../inventory/stock';
import { acceptDocument, deleteDocument, documentFilePath, ingestDocument, rejectDocument, reprocessDocument, type DocOptions } from '../ai/documents';
import { listEntries, postEntry, postReady, setSkipped, updateEntry } from '../ai/intake/entries';
import { resolveParty } from '../ai/resolver';
import { cancelSession, confirmSession, handleUtterance } from '../ai/voice/engine';
import { asLang } from '../ai/voice/i18n';
import { requireUser } from '../auth/routes';
import { isAdmin } from '../auth/auth';
import { aiKeyStatus, removeAiKey, setAiKey } from '../ai/key';
import { listBackups, writeBackup } from '../db/backup';
import { renameGroup, updateItem, updateLedger, updateParty } from '../ledger/alter';
import { countCash, createBox, DENOMINATIONS, listBoxes, pettyCashBook, recordExpense, topUp, updateBox } from '../pettycash/service';
import { addSchedule, assetDetail, createAsset, listAssets, logUpkeep, removeSchedule, updateAsset } from '../assets/service';
import { clearOldDocuments, closeYear, healthCheck, oldDocuments, yearClosePreview } from '../upkeep/service';
import { loadConfig, publicConfig, recentLog, saveConfig, sendDigest, TEMPLATES } from '../notify/service';

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string | undefined>; Body: any }>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (req: Req): any => (req.body as any) ?? {};

const date = (v: string | undefined, fallback: string) => {
  const d = v ?? fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw invalid(`Bad date: ${d}`);
  return d;
};

export function registerRoutes(app: FastifyInstance, db: PGlite) {
  /** The logged-in user (the onRequest hook has already rejected anonymous calls). */
  const uid = (req: Req) => requireUser(req).id;

  /** The company in the URL, only if the logged-in user is a member; otherwise it does not exist for them. */
  async function company(req: Req) {
    const user = requireUser(req);
    const c = await maybeOne<{ id: string; fy_start_month: number }>(db,
      `SELECT c.id, c.fy_start_month FROM companies c JOIN company_members m ON m.company_id = c.id
        WHERE c.id = $1 AND m.user_id = $2`, [req.params.cid, user.id]);
    if (!c) throw notFound('Company');
    return c;
  }

  // ---------- Whole installation: AI key and backups (the administrator, i.e. the first account, only) ----------
  const requireAdmin = async (req: Req, what: string) => {
    if (!await isAdmin(db, requireUser(req).id)) {
      throw new AppError('FORBIDDEN', 403, `Only the administrator (the first account created on this computer) can ${what}.`);
    }
  };
  app.get('/api/v1/settings/ai-key', async (req: Req) => ({ ...aiKeyStatus(), canChange: await isAdmin(db, requireUser(req).id) }));
  app.put('/api/v1/settings/ai-key', async (req: Req) => { await requireAdmin(req, 'change the AI key'); return setAiKey(body(req).apiKey); });
  app.delete('/api/v1/settings/ai-key', async (req: Req) => { await requireAdmin(req, 'change the AI key'); return removeAiKey(); });

  app.get('/api/v1/backups', async (req: Req) => {
    await requireAdmin(req, 'see backups');
    const files = listBackups(config.backupDir).reverse();
    return { dir: config.backupDir, files: files.map((f) => ({ name: f, bytes: fs.statSync(path.join(config.backupDir, f)).size })) };
  });
  app.post('/api/v1/backups', async (req: Req) => {
    await requireAdmin(req, 'make backups');
    const file = await writeBackup(db, config.backupDir);
    return { name: path.basename(file), bytes: fs.statSync(file).size };
  });
  app.get('/api/v1/backups/:name', async (req: Req, reply) => {
    await requireAdmin(req, 'download backups');
    const name = req.params.name;
    if (!listBackups(config.backupDir).includes(name)) throw notFound('Backup');
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(fs.createReadStream(path.join(config.backupDir, name)));
  });

  app.get('/api/v1/status', async () => {
    const hasUsers = Boolean(await maybeOne(db, 'SELECT 1 FROM users LIMIT 1'));
    return {
      app: 'Kannaku AI', aiEnabled: config.aiEnabled, model: config.model, today: todayIST(), states: STATES, hasUsers,
      // Before the first sign-up only: books already on this machine, which the first account will own.
      unclaimed: hasUsers ? [] : (await many<{ name: string }>(db, 'SELECT name FROM companies ORDER BY created_at')).map((r) => r.name),
    };
  });

  app.patch('/api/v1/companies/:cid', async (req: Req) => {
    const c = await company(req);
    const b = body(req);
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) throw invalid('Enter the business name');
    if (b.lockDate && (typeof b.lockDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.lockDate))) throw invalid('Lock date is not a valid date');
    for (const k of ['voiceLimit', 'autoPostLimit']) {
      if (b[k] === undefined) continue;
      b[k] = String(b[k]).replace(/,/g, '').trim();
      if (!/^\d+(\.\d+)?$/.test(b[k])) throw invalid('Enter the limit as an amount in rupees, like 50000');
    }
    if (b.fyNumberingFrom !== undefined) {
      // Only from the first day of a financial year that has no vouchers yet, so a year's series never mixes formats.
      const d = b.fyNumberingFrom;
      if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || fyStart(d, c.fy_start_month) !== d) throw invalid('Numbering by financial year starts on the first day of a financial year');
      if (await maybeOne(db, `SELECT 1 FROM vouchers WHERE company_id = $1 AND voucher_date >= $2 LIMIT 1`, [c.id, d])) {
        throw invalid('Vouchers are already posted in that year; choose a year that has none yet');
      }
    }
    if (b.name !== undefined) await db.query(`UPDATE companies SET name = $2 WHERE id = $1`, [c.id, b.name.trim().slice(0, 120)]);
    if (b.fyNumberingFrom !== undefined) await db.query(`UPDATE companies SET fy_numbering_from = $2 WHERE id = $1`, [c.id, b.fyNumberingFrom]);
    if (b.lockDate !== undefined) await db.query(`UPDATE companies SET lock_date = $2 WHERE id = $1`, [c.id, b.lockDate || null]);
    if (b.voiceLimit !== undefined) await db.query(`UPDATE companies SET voice_limit_minor = $2 WHERE id = $1`, [c.id, toMinor(b.voiceLimit)]);
    if (b.roundInvoice !== undefined) await db.query(`UPDATE companies SET round_invoice = $2 WHERE id = $1`, [c.id, Boolean(b.roundInvoice)]);
    if (b.autoPost !== undefined) await db.query(`UPDATE companies SET auto_post = $2 WHERE id = $1`, [c.id, Boolean(b.autoPost)]);
    if (b.autoPostLimit !== undefined) await db.query(`UPDATE companies SET auto_post_limit_minor = $2 WHERE id = $1`, [c.id, toMinor(b.autoPostLimit)]);
    if (b.gstin !== undefined) {
      if (b.gstin && !isValidGstin(b.gstin)) throw invalid('GSTIN is not valid');
      await db.query(`UPDATE companies SET gstin = $2 WHERE id = $1`, [c.id, b.gstin || null]);
    }
    return { ok: true };
  });

  const P = '/api/v1/companies/:cid';

  app.get(`${P}/dashboard`, async (req: Req) => dashboard(db, (await company(req)).id));

  // ---------- Masters ----------
  app.get(`${P}/groups`, async (req: Req) => listGroups(db, (await company(req)).id));
  app.post(`${P}/groups`, async (req: Req) => createGroup(db, (await company(req)).id, body(req)));

  app.get(`${P}/ledgers`, async (req: Req) => {
    const c = await company(req);
    return many(db,
      `SELECT l.id, l.name, g.name AS "groupName", g.id AS "groupId", g.path::text AS path, g.nature, l.system_code AS "systemCode",
              l.counterparty_id AS "counterpartyId", l.bill_wise AS "billWise", l.tax_component AS "taxComponent",
              (g.path ~ '*.bank_accounts|cash_in_hand|bank_od.*') AS "isCashBank", l.is_active AS "isActive",
              COALESCE((SELECT SUM(e.amount_minor) FROM ledger_entries e WHERE e.ledger_id = l.id), 0)::bigint AS "balanceMinor"
         FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
        WHERE l.company_id = $1 AND ($2 OR l.is_active) ORDER BY l.name`, [c.id, req.query.all === '1']);
  });
  app.post(`${P}/ledgers`, async (req: Req) => createLedger(db, (await company(req)).id, body(req), uid(req)));
  app.post(`${P}/ledgers/:id/opening`, async (req: Req) => {
    const c = await company(req);
    const amt = toMinor(body(req).amount ?? '0') * (body(req).side === 'CR' ? -1n : 1n);
    return setOpeningBalance(db, c.id, req.params.id, amt, uid(req));
  });

  app.get(`${P}/parties`, async (req: Req) => {
    const c = await company(req);
    return many(db,
      `SELECT cp.id, cp.legal_name AS name, cp.gstin, cp.state_code AS "stateCode", cp.city, cp.phone, cp.credit_days AS "creditDays",
              cp.status, cp.gst_reg_type AS "regType", l.id AS "ledgerId", g.name AS "groupName",
              CASE WHEN g.path ~ '*.sundry_debtors.*' THEN 'CUSTOMER' WHEN g.path ~ '*.sundry_creditors.*' THEN 'SUPPLIER' ELSE 'OTHER' END AS kind,
              COALESCE((SELECT SUM(e.amount_minor) FROM ledger_entries e WHERE e.ledger_id = l.id), 0)::bigint AS "balanceMinor"
         FROM counterparties cp JOIN ledgers l ON l.counterparty_id = cp.id JOIN ledger_groups g ON g.id = l.group_id
        WHERE cp.company_id = $1 AND ($2 OR cp.status <> 'INACTIVE') ORDER BY cp.legal_name`, [c.id, req.query.all === '1']);
  });
  app.post(`${P}/parties`, async (req: Req) => createParty(db, (await company(req)).id, body(req), uid(req)));
  app.get(`${P}/parties/match`, async (req: Req) => resolveParty(db, (await company(req)).id, { name: req.query.name ?? null, gstin: req.query.gstin ?? null }));

  app.get(`${P}/items`, async (req: Req) => {
    const c = await company(req);
    return many(db,
      `SELECT i.id, i.name, i.hsn_sac AS "hsnSac", i.gst_rate_ppm AS "gstRatePpm", i.valuation, u.symbol AS uom, u.id AS "uomId",
              i.is_active AS "isActive", i.allow_negative AS "allowNegative",
              COALESCE((SELECT SUM(qty) FROM inventory_entries ie WHERE ie.item_id = i.id), 0)::text AS "qtyOnHand"
         FROM stock_items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.company_id = $1 AND ($2 OR i.is_active) ORDER BY i.name`, [c.id, req.query.all === '1']);
  });
  app.post(`${P}/items`, async (req: Req) => createItem(db, (await company(req)).id, body(req), uid(req)));
  app.get(`${P}/uoms`, async (req: Req) => many(db, `SELECT id, symbol, uqc, decimals FROM uoms WHERE company_id = $1 ORDER BY symbol`, [(await company(req)).id]));
  // Altering masters (rename, change details, switch off / on).
  app.patch(`${P}/ledgers/:id`, async (req: Req) => updateLedger(db, (await company(req)).id, req.params.id, body(req), uid(req)));
  app.patch(`${P}/parties/:id`, async (req: Req) => updateParty(db, (await company(req)).id, req.params.id, body(req), uid(req)));
  app.patch(`${P}/items/:id`, async (req: Req) => updateItem(db, (await company(req)).id, req.params.id, body(req), uid(req)));
  app.patch(`${P}/groups/:id`, async (req: Req) => renameGroup(db, (await company(req)).id, req.params.id, body(req).name, uid(req)));
  app.get(`${P}/godowns`, async (req: Req) => many(db, `SELECT id, name, is_default AS "isDefault" FROM godowns WHERE company_id = $1 ORDER BY name`, [(await company(req)).id]));

  // ---------- Vouchers ----------
  app.post(`${P}/vouchers/preview`, async (req: Req) => previewVoucher(db, (await company(req)).id, body(req)));
  app.post(`${P}/vouchers`, async (req: Req) => {
    const c = await company(req);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) throw invalid('Idempotency-Key header is required');
    return postVoucher(db, c.id, body(req), { source: 'MANUAL', idempotencyKey: key, userId: uid(req) });
  });
  app.get(`${P}/vouchers`, async (req: Req) => {
    const c = await company(req);
    const today = todayIST();
    return daybook(db, c.id, date(req.query.from, today), date(req.query.to, today), { type: req.query.type, partyId: req.query.party });
  });
  app.get(`${P}/vouchers/:id`, async (req: Req) => voucherDetail(db, (await company(req)).id, req.params.id));
  app.post(`${P}/vouchers/:id/reverse`, async (req: Req) => {
    const c = await company(req);
    return reverseVoucher(db, c.id, req.params.id, { userId: uid(req), source: 'MANUAL', date: body(req).date });
  });
  // A sale or purchase in a closed period is corrected by a note; this prepares it (nothing is posted).
  app.get(`${P}/vouchers/:id/correction-note`, async (req: Req) => correctionNote(db, (await company(req)).id, req.params.id));
  app.post(`${P}/vouchers/:id/alter`, async (req: Req) => {
    const c = await company(req);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) throw invalid('Idempotency-Key header is required');
    return alterVoucher(db, c.id, req.params.id, body(req), { source: 'MANUAL', idempotencyKey: key, userId: uid(req) });
  });
  app.get(`${P}/bills/open`, async (req: Req) => openBills(db, (await company(req)).id, req.query.ledgerId ?? ''));

  // Drafts (manual "save for later" and the AI write path)
  app.get(`${P}/drafts`, async (req: Req) => many(db,
    `SELECT id, payload, source, status, created_at AS "createdAt" FROM voucher_drafts
      WHERE company_id = $1 AND status = 'OPEN' AND source = 'MANUAL' ORDER BY created_at DESC`, [(await company(req)).id]));
  app.post(`${P}/drafts`, async (req: Req) => one(db,
    `INSERT INTO voucher_drafts (company_id, payload, source, created_by) VALUES ($1,$2,'MANUAL',$3) RETURNING id`,
    [(await company(req)).id, JSON.stringify(body(req)), uid(req)]));
  app.post(`${P}/drafts/:id/post`, async (req: Req) => {
    const c = await company(req);
    const d = await maybeOne<{ payload: unknown; source: Source; status: string }>(db, `SELECT payload, source, status FROM voucher_drafts WHERE id = $1 AND company_id = $2`, [req.params.id, c.id]);
    if (!d) throw notFound('Draft');
    if (d.status !== 'OPEN') throw new AppError('DRAFT_CLOSED', 409, `Draft is ${d.status.toLowerCase()}`);
    return postVoucher(db, c.id, { ...(d.payload as object), ...(body(req)) }, { source: d.source, idempotencyKey: `draft:${req.params.id}`, userId: uid(req), draftId: req.params.id });
  });

  // ---------- Reports ----------
  app.get(`${P}/reports/trial-balance`, async (req: Req) => trialBalance(db, (await company(req)).id, date(req.query.as_of, todayIST())));
  app.get(`${P}/reports/profit-loss`, async (req: Req) => {
    const c = await company(req);
    const to = date(req.query.to, todayIST());
    return profitAndLoss(db, c.id, date(req.query.from, fyStart(to, c.fy_start_month)), to);
  });
  app.get(`${P}/reports/balance-sheet`, async (req: Req) => balanceSheet(db, (await company(req)).id, date(req.query.as_of, todayIST())));
  app.get(`${P}/reports/ageing`, async (req: Req) => ageing(db, (await company(req)).id, req.query.side === 'payable' ? 'payable' : 'receivable', date(req.query.as_of, todayIST())));
  app.get(`${P}/reports/ledger/:ledgerId`, async (req: Req) => {
    const c = await company(req);
    const to = date(req.query.to, todayIST());
    return ledgerStatement(db, c.id, req.params.ledgerId, date(req.query.from, fyStart(to, c.fy_start_month)), to);
  });
  app.get(`${P}/reports/stock-summary`, async (req: Req) => stockAsOf(db, (await company(req)).id, date(req.query.as_of, todayIST())));
  app.get(`${P}/reports/gst-summary`, async (req: Req) => {
    const c = await company(req);
    const to = date(req.query.to, todayIST());
    return gstSummary(db, c.id, date(req.query.from, `${to.slice(0, 7)}-01`), to);
  });
  app.get(`${P}/audit/verify-chain`, async (req: Req) => verifyChain(db, (await company(req)).id));

  // ---------- Compliance calendar: GST / TDS / income-tax due dates, filing records, own reminders ----------
  app.get(`${P}/compliance`, async (req: Req) => {
    const c = await company(req);
    const today = todayIST();
    const from = date(req.query.from, addDays(today, -31));
    const to = date(req.query.to, addDays(today, 92));
    if (from > to || daysBetween(from, to) > 800) throw invalid('Choose a period of up to two years');
    return { from, to, today, settings: await complianceSettings(db, c.id), items: await complianceItems(db, c.id, from, to, today), tasks: await listTasks(db, c.id) };
  });
  app.get(`${P}/compliance/alerts`, async (req: Req) => complianceAlerts(db, (await company(req)).id));
  app.put(`${P}/compliance/settings`, async (req: Req) => updateComplianceSettings(db, (await company(req)).id, body(req), uid(req)));
  app.put(`${P}/compliance/records/:key`, async (req: Req) => saveRecord(db, (await company(req)).id, req.params.key, body(req), uid(req)));
  app.post(`${P}/compliance/tasks`, async (req: Req) => createTask(db, (await company(req)).id, body(req), uid(req)));
  app.delete(`${P}/compliance/tasks/:id`, async (req: Req) => { await deleteTask(db, (await company(req)).id, req.params.id, uid(req)); return { ok: true }; });

  /** Posting routes need an Idempotency-Key header so a double click cannot post twice. */
  const idem = (req: Req) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) throw invalid('Idempotency-Key header is required');
    return key;
  };

  // ---------- Petty cash (imprest) ----------
  app.get(`${P}/petty-cash`, async (req: Req) => ({ boxes: await listBoxes(db, (await company(req)).id), denominations: DENOMINATIONS }));
  app.post(`${P}/petty-cash`, async (req: Req) => createBox(db, (await company(req)).id, body(req), uid(req)));
  app.patch(`${P}/petty-cash/:id`, async (req: Req) => { await updateBox(db, (await company(req)).id, req.params.id, body(req), uid(req)); return { ok: true }; });
  app.post(`${P}/petty-cash/:id/expenses`, async (req: Req) => recordExpense(db, (await company(req)).id, req.params.id, body(req), { idempotencyKey: idem(req), userId: uid(req) }));
  app.post(`${P}/petty-cash/:id/top-up`, async (req: Req) => topUp(db, (await company(req)).id, req.params.id, body(req), { idempotencyKey: idem(req), userId: uid(req) }));
  app.post(`${P}/petty-cash/:id/counts`, async (req: Req) => countCash(db, (await company(req)).id, req.params.id, body(req), { idempotencyKey: idem(req), userId: uid(req) }));
  app.get(`${P}/petty-cash/:id/book`, async (req: Req) => {
    const c = await company(req);
    const to = date(req.query.to, todayIST());
    return pettyCashBook(db, c.id, req.params.id, date(req.query.from, `${to.slice(0, 7)}-01`), to);
  });

  // ---------- Asset register and upkeep ----------
  app.get(`${P}/assets`, async (req: Req) => listAssets(db, (await company(req)).id, req.query.all === '1'));
  app.post(`${P}/assets`, async (req: Req) => createAsset(db, (await company(req)).id, body(req), uid(req)));
  app.get(`${P}/assets/:id`, async (req: Req) => assetDetail(db, (await company(req)).id, req.params.id));
  app.patch(`${P}/assets/:id`, async (req: Req) => { await updateAsset(db, (await company(req)).id, req.params.id, body(req), uid(req)); return { ok: true }; });
  app.post(`${P}/assets/:id/schedules`, async (req: Req) => addSchedule(db, (await company(req)).id, req.params.id, body(req), uid(req)));
  app.delete(`${P}/asset-schedules/:id`, async (req: Req) => { await removeSchedule(db, (await company(req)).id, req.params.id, uid(req)); return { ok: true }; });
  app.post(`${P}/assets/:id/logs`, async (req: Req) => logUpkeep(db, (await company(req)).id, req.params.id, body(req), { idempotencyKey: idem(req), userId: uid(req) }));

  // ---------- Reminder digests by email, WhatsApp, SMS ----------
  app.get(`${P}/notifications`, async (req: Req) => {
    const c = await company(req);
    return { config: publicConfig(await loadConfig(db, c.id)), templates: TEMPLATES, log: await recentLog(db, c.id) };
  });
  app.put(`${P}/notifications`, async (req: Req) => saveConfig(db, (await company(req)).id, body(req), uid(req)));
  app.post(`${P}/notifications/test`, async (req: Req) => {
    const ch = body(req).channel;
    if (ch !== 'EMAIL' && ch !== 'WHATSAPP' && ch !== 'SMS') throw invalid('Choose EMAIL, WHATSAPP or SMS');
    return sendDigest(db, (await company(req)).id, { test: true, only: ch });
  });

  // ---------- App upkeep: health check, old uploads, closing the year ----------
  app.get(`${P}/upkeep/health`, async (req: Req) => healthCheck(db, (await company(req)).id, { isAdmin: await isAdmin(db, uid(req)) }));
  app.get(`${P}/upkeep/old-documents`, async (req: Req) => oldDocuments(db, (await company(req)).id, Number(req.query.days ?? 90) || 90));
  app.post(`${P}/upkeep/old-documents/delete`, async (req: Req) => clearOldDocuments(db, (await company(req)).id, body(req).ids, uid(req)));
  app.get(`${P}/upkeep/year-close`, async (req: Req) => yearClosePreview(db, (await company(req)).id, String(req.query.end ?? '')));
  app.post(`${P}/upkeep/year-close`, async (req: Req) => closeYear(db, (await company(req)).id, String(body(req).end ?? ''), uid(req)));

  // ---------- Documents: bills, invoices, bank statements, workings, registers ----------
  const docOptions = (raw: Record<string, unknown>): DocOptions => ({
    docType: (typeof raw.docType === 'string' && raw.docType && raw.docType !== 'AUTO' ? raw.docType : null) as DocOptions['docType'],
    bankLedgerId: typeof raw.bankLedgerId === 'string' && raw.bankLedgerId ? raw.bankLedgerId : null,
    registerKind: raw.registerKind === 'SALES' || raw.registerKind === 'PURCHASE' ? raw.registerKind : null,
    date: typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null,
  });
  app.post(`${P}/documents`, async (req: Req) => {
    const c = await company(req);
    const results: unknown[] = [];
    const fields: Record<string, unknown> = {};
    // Form fields (document type, bank account) come before the files they apply to.
    for await (const part of req.parts()) {
      if (part.type === 'field') { fields[part.fieldname] = part.value; continue; }
      const data = await part.toBuffer();
      try {
        results.push({ fileName: part.filename, ...(await ingestDocument(db, c.id, { name: part.filename, mime: part.mimetype, data }, uid(req), docOptions(fields))) });
      } catch (e) {
        if (e instanceof AppError) results.push({ fileName: part.filename, error: { code: e.code, message: e.message, details: e.details } });
        else throw e;
      }
    }
    return results;
  });
  app.get(`${P}/documents`, async (req: Req) => many(db,
    `SELECT d.id, d.file_name AS "fileName", d.mime, d.status, d.error, d.created_at AS "createdAt", d.voucher_id AS "voucherId", d.doc_type AS "docType",
            d.summary->>'bankLedgerName' AS "bankLedgerName",
            (SELECT jsonb_object_agg(status, n) FROM (SELECT status, COUNT(*)::int AS n FROM document_entries e WHERE e.document_id = d.id GROUP BY status) s) AS counts,
            d.extraction->'supplier'->'name'->>'value' AS supplier, d.extraction->'invoice_number'->>'value' AS "invoiceNo",
            d.extraction->'totals'->'grand_total'->>'value' AS "grandTotal",
            (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(d.validation, '[]'::jsonb)) x WHERE x->>'severity' = 'error')::int AS errors
       FROM documents d WHERE d.company_id = $1 ORDER BY d.created_at DESC LIMIT 200`, [(await company(req)).id]));
  app.get(`${P}/documents/:id`, async (req: Req) => {
    const c = await company(req);
    const d = await maybeOne<Record<string, unknown>>(db,
      `SELECT d.id, d.file_name AS "fileName", d.mime, d.status, d.error, d.extraction, d.validation, d.matches,
              d.voucher_id AS "voucherId", d.model, d.prompt_version AS "promptVersion", vd.payload AS draft,
              d.doc_type AS "docType", d.summary, d.options, d.bank_ledger_id AS "bankLedgerId"
         FROM documents d LEFT JOIN voucher_drafts vd ON vd.id = d.draft_id WHERE d.id = $1 AND d.company_id = $2`, [req.params.id, c.id]);
    if (!d) throw notFound('Document');
    return { ...d, entries: await listEntries(db, c.id, req.params.id) };
  });
  app.get(`${P}/documents/:id/file`, async (req: Req, reply) => {
    const c = await company(req);
    const d = await maybeOne<{ storage_key: string; mime: string }>(db, `SELECT storage_key, mime FROM documents WHERE id = $1 AND company_id = $2`, [req.params.id, c.id]);
    if (!d) throw notFound('Document');
    reply.header('Content-Type', d.mime);
    reply.header('Cache-Control', 'private, max-age=3600');
    // Spreadsheets download; PDFs and images show inline. nosniff stops a crafted upload being run as a page.
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!/^(application\/pdf|image\/(jpeg|png|webp|gif))$/.test(d.mime)) reply.header('Content-Disposition', 'attachment');
    return reply.send(fs.createReadStream(documentFilePath(d.storage_key)));
  });
  app.post(`${P}/documents/:id/accept`, async (req: Req) => acceptDocument(db, (await company(req)).id, req.params.id, body(req), uid(req)));
  app.post(`${P}/documents/:id/reject`, async (req: Req) => { await rejectDocument(db, (await company(req)).id, req.params.id); return { ok: true }; });
  app.delete(`${P}/documents/:id`, async (req: Req) => { await deleteDocument(db, (await company(req)).id, req.params.id, uid(req)); return { ok: true }; });
  app.post(`${P}/documents/:id/retry`, async (req: Req) => {
    const c = await company(req);
    await reprocessDocument(db, c.id, req.params.id, docOptions(body(req)));
    return { ok: true };
  });
  // Entries of multi-entry documents (statement lines, journals, register rows).
  const E = `${P}/documents/:id/entries/:eid`;
  app.put(E, async (req: Req) => updateEntry(db, (await company(req)).id, req.params.id, req.params.eid, body(req).payload));
  app.post(`${E}/post`, async (req: Req) => {
    const b = body(req);
    return postEntry(db, (await company(req)).id, req.params.id, req.params.eid, uid(req), { payload: b.payload ?? undefined, confirmWarnings: Boolean(b.confirmWarnings) });
  });
  app.post(`${E}/skip`, async (req: Req) => { await setSkipped(db, (await company(req)).id, req.params.id, req.params.eid, body(req).skip !== false); return { ok: true }; });
  app.post(`${P}/documents/:id/post-ready`, async (req: Req) => postReady(db, (await company(req)).id, req.params.id, uid(req)));

  // ---------- Voice ----------
  app.post(`${P}/voice/utterance`, async (req: Req) => {
    const c = await company(req);
    const b = body(req);
    if (typeof b.transcript !== 'string') throw invalid('transcript is required');
    return handleUtterance(db, c.id, { transcript: b.transcript.slice(0, 2000), confidence: b.confidence ?? null, sessionId: b.sessionId ?? null, screen: b.screen ?? null, lang: asLang(b.lang), userId: uid(req) });
  });
  app.post(`${P}/voice/sessions/:id/confirm`, async (req: Req) => confirmSession(db, (await company(req)).id, req.params.id, body(req).channel === 'screen' ? 'screen' : 'voice', asLang(body(req).lang), uid(req)));
  app.post(`${P}/voice/sessions/:id/cancel`, async (req: Req) => cancelSession(db, (await company(req)).id, req.params.id, asLang(body(req).lang)));
}
