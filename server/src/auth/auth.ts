import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { PGlite } from '@electric-sql/pglite';
import { many, maybeOne, one, type Db } from '../db/client';
import { AppError, invalid } from '../lib/errors';
import { isValidGstin, gstinState, STATES } from '../lib/gstin';
import { fyStart, todayIST } from '../lib/dates';
import { createCompany } from '../ledger/masters';
import { seedDemo, DEMO_COMPANY_NAME } from '../db/demo';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'kannaku_session';
export const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface User { id: string; email: string; name: string; phone: string | null }
export interface Membership { id: string; name: string; gstin: string | null; stateCode: string; role: string }

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(db: Db, userId: string, userAgent: string | null): Promise<{ token: string; expires: Date }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.query(`INSERT INTO user_sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1,$2,$3,$4)`,
    [sha256(token), userId, expires.toISOString(), userAgent?.slice(0, 300) ?? null]);
  return { token, expires };
}

export async function userForToken(db: Db, token: string | null): Promise<User | null> {
  if (!token) return null;
  return maybeOne<User>(db,
    `SELECT u.id, u.email, u.name, u.phone FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
}

export async function endSession(db: Db, token: string | null) {
  if (token) await db.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [sha256(token)]);
}

export async function purgeExpiredSessions(db: Db) {
  await db.query(`DELETE FROM user_sessions WHERE expires_at <= now()`);
}

/**
 * The installation's administrator: the first account created on this server. Settings that affect every
 * company here (the AI key, whole-database backups) are theirs alone, since anyone who signs up owns their own company.
 */
export async function isAdmin(db: Db, userId: string): Promise<boolean> {
  const first = await maybeOne<{ id: string }>(db, `SELECT id FROM users ORDER BY created_at, id LIMIT 1`);
  return first?.id === userId;
}

export async function memberships(db: Db, userId: string): Promise<Membership[]> {
  return many<Membership>(db,
    `SELECT c.id, c.name, c.gstin, c.state_code AS "stateCode", m.role
       FROM company_members m JOIN companies c ON c.id = m.company_id
      WHERE m.user_id = $1 ORDER BY c.created_at`, [userId]);
}

export async function isMember(db: Db, userId: string, companyId: string): Promise<boolean> {
  return Boolean(await maybeOne(db, `SELECT 1 FROM company_members WHERE user_id = $1 AND company_id = $2`, [userId, companyId]));
}

// ---------- Brute-force protection (per email, in memory) ----------
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

function checkLock(email: string) {
  const f = failures.get(email);
  if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
    const mins = Math.ceil((f.until - Date.now()) / 60_000);
    throw new AppError('LOCKED', 429, `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
}
function noteFailure(email: string) {
  // Keep the map from growing without bound when someone tries many different emails.
  if (failures.size > 10_000) for (const [k, v] of failures) if (v.until <= Date.now()) failures.delete(k);
  const f = failures.get(email);
  const count = f && f.until > Date.now() ? f.count + 1 : 1;
  failures.set(email, { count, until: Date.now() + LOCK_MS });
}

export interface CompanyDetails { name: string; gstin?: string | null; stateCode?: string | null; booksFrom?: string | null }

export function validateCompany(c: CompanyDetails | undefined): { name: string; gstin: string | null; stateCode: string; booksFrom: string } {
  if (!c || !c.name?.trim()) throw invalid('Enter your business name');
  const gstin = c.gstin?.trim().toUpperCase() || null;
  if (gstin && !isValidGstin(gstin)) throw invalid('That GSTIN is not valid. Check it, or leave it empty if you are not registered.');
  const stateCode = gstin ? gstinState(gstin) : c.stateCode ?? '';
  if (!STATES[stateCode]) throw invalid('Choose the state your business is registered in');
  const booksFrom = c.booksFrom || fyStart(todayIST());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booksFrom)) throw invalid('Books start date is not valid');
  return { name: c.name.trim().slice(0, 120), gstin, stateCode, booksFrom };
}

export interface SignupInput {
  name: string;
  email: string;
  phone?: string | null;
  password: string;
  company: CompanyDetails;
  demo?: boolean;
}

/** Creates the account and its first company. The first account on a server also takes over books created before accounts existed. */
export async function signup(db: PGlite, s: SignupInput): Promise<{ user: User; companyId: string }> {
  const email = s.email?.trim().toLowerCase() ?? '';
  if (!s.name?.trim()) throw invalid('Enter your name');
  if (!EMAIL_RE.test(email)) throw invalid('Enter a valid email address');
  if (!s.password || s.password.length < 8) throw invalid('Password must be at least 8 characters');
  if (s.phone && !/^[+\d][\d\s-]{6,16}$/.test(s.phone.trim())) throw invalid('Mobile number is not valid');
  const company = validateCompany(s.company);
  if (await maybeOne(db, `SELECT 1 FROM users WHERE email = $1`, [email])) {
    throw new AppError('EMAIL_TAKEN', 409, 'An account with this email already exists. Log in instead.');
  }

  const passwordHash = await hashPassword(s.password);
  const isFirstUser = !(await maybeOne(db, `SELECT 1 FROM users LIMIT 1`));
  const user = await one<User>(db,
    `INSERT INTO users (email, name, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, name, phone`,
    [email, s.name.trim().slice(0, 120), s.phone?.trim() || null, passwordHash]);

  if (isFirstUser) {
    // Books created before sign-in existed (e.g. the old demo) belong to the first account.
    await db.query(
      `INSERT INTO company_members (company_id, user_id, role)
       SELECT c.id, $1, 'OWNER' FROM companies c WHERE NOT EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = c.id)`, [user.id]);
  }
  const created = await addCompany(db, user.id, company);
  if (s.demo) await addDemo(db, user.id);
  return { user, companyId: created.id };
}

export async function addCompany(db: PGlite, userId: string, details: CompanyDetails) {
  const c = validateCompany(details);
  const id = await createCompany(db, c);
  await db.query(`INSERT INTO company_members (company_id, user_id, role) VALUES ($1,$2,'OWNER')`, [id, userId]);
  return { id };
}

/** Adds the sample company, unless this user already has it. */
export async function addDemo(db: PGlite, userId: string) {
  const has = await maybeOne(db,
    `SELECT 1 FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1 AND c.name = $2`, [userId, DEMO_COMPANY_NAME]);
  if (has) return;
  const id = await seedDemo(db);
  await db.query(`INSERT INTO company_members (company_id, user_id, role) VALUES ($1,$2,'OWNER')`, [id, userId]);
}

export async function login(db: Db, emailRaw: string, password: string): Promise<User> {
  const email = emailRaw?.trim().toLowerCase() ?? '';
  checkLock(email);
  const row = await maybeOne<User & { password_hash: string }>(db,
    `SELECT id, email, name, phone, password_hash FROM users WHERE email = $1`, [email]);
  // Same message whether the email or the password was wrong.
  if (!row || !(await verifyPassword(password ?? '', row.password_hash))) {
    noteFailure(email);
    throw new AppError('BAD_LOGIN', 401, 'Email or password is incorrect.');
  }
  failures.delete(email);
  await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
  await db.query(`DELETE FROM user_sessions WHERE user_id = $1 AND expires_at <= now()`, [row.id]);
  return { id: row.id, email: row.email, name: row.name, phone: row.phone };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(token: string, expires: Date, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}
export const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
