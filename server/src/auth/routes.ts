import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { AppError } from '../lib/errors';
import {
  addCompany, addDemo, changePassword, clearCookie, createSession, endSession, isAdmin, listSessions, login, memberships, readCookie,
  SESSION_COOKIE, sessionCookie, signOutOthers, signup, updateProfile, type User,
} from './auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (req: FastifyRequest): any => (req.body as any) ?? {};
const isHttps = (req: FastifyRequest) => req.protocol === 'https';

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 401, 'Please log in.');
  return req.user;
}

export function registerAuthRoutes(app: FastifyInstance, db: PGlite) {
  const startSession = async (req: FastifyRequest, reply: FastifyReply, user: User) => {
    const { token, expires } = await createSession(db, user.id, req.headers['user-agent'] ?? null);
    reply.header('Set-Cookie', sessionCookie(token, expires, isHttps(req)));
    return { user, companies: await memberships(db, user.id), isAdmin: await isAdmin(db, user.id) };
  };

  app.get('/api/v1/auth/me', async (req) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 401, 'Please log in.');
    return { user: req.user, companies: await memberships(db, req.user.id), isAdmin: await isAdmin(db, req.user.id) };
  });

  // ---------- Own account (signed in) ----------
  const token = (req: FastifyRequest) => readCookie(req.headers.cookie, SESSION_COOKIE);
  app.patch('/api/v1/account/profile', async (req) => ({ user: await updateProfile(db, requireUser(req).id, body(req)) }));
  app.post('/api/v1/account/password', async (req) => {
    const b = body(req);
    return changePassword(db, requireUser(req).id, b.currentPassword, b.newPassword, token(req));
  });
  app.get('/api/v1/account/sessions', async (req) => listSessions(db, requireUser(req).id, token(req)));
  app.post('/api/v1/account/sessions/sign-out-others', async (req) => signOutOthers(db, requireUser(req).id, token(req)));

  app.post('/api/v1/auth/signup', async (req, reply) => {
    const { user, companyId } = await signup(db, body(req));
    return { ...(await startSession(req, reply, user)), companyId };
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const b = body(req);
    const user = await login(db, b.email, b.password);
    return startSession(req, reply, user);
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    await endSession(db, readCookie(req.headers.cookie, SESSION_COOKIE));
    reply.header('Set-Cookie', clearCookie);
    return { ok: true };
  });

  // Companies are listed and created per user.
  app.get('/api/v1/companies', async (req) => {
    const user = requireUser(req);
    return (await db.query(
      `SELECT c.id, c.name, c.gstin, c.state_code AS "stateCode", c.books_from::text AS "booksFrom", c.lock_date::text AS "lockDate",
              c.fy_start_month AS "fyStartMonth", c.voice_limit_minor AS "voiceLimitMinor", c.round_invoice AS "roundInvoice", m.role,
              c.auto_post AS "autoPost", c.auto_post_limit_minor AS "autoPostLimitMinor", c.fy_numbering_from::text AS "fyNumberingFrom"
         FROM company_members m JOIN companies c ON c.id = m.company_id
        WHERE m.user_id = $1 ORDER BY c.created_at`, [user.id])).rows;
  });

  app.post('/api/v1/companies', async (req) => {
    const user = requireUser(req);
    const b = body(req);
    if (b.demo) { await addDemo(db, user.id); return { ok: true }; }
    return addCompany(db, user.id, b);
  });
}
