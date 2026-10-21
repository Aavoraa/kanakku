import fs from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import { AppError } from './lib/errors';
import { bigintJson } from './ledger/post';
import { registerRoutes } from './api/routes';
import { registerAuthRoutes } from './auth/routes';
import { readCookie, SESSION_COOKIE, userForToken, type User } from './auth/auth';
import type { Database } from './db/client';

declare module 'fastify' {
  interface FastifyRequest { user: User | null }
}

/** Routes anyone may call without logging in. */
const PUBLIC = [/^\/api\/v1\/status$/, /^\/api\/v1\/auth\/(signup|login|logout|me)$/];

export async function buildApp(db: Database, opts: { serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  // Behind Vercel's proxy, trust X-Forwarded-Proto so the session cookie is marked Secure.
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024, trustProxy: config.demo });
  // BigInt (paise) serialises as a string; the client never sees a float amount.
  app.setReplySerializer((payload) => JSON.stringify(payload, bigintJson));
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 20 } });

  app.decorateRequest('user', null);
  // Every API call except the public ones needs a valid session.
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/api/')) return;
    // Changes may only come from this app's own pages. The session cookie is SameSite=Lax, but every other
    // port on localhost counts as the same site, so a page served by another local program could post here.
    const fetchSite = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && req.method !== 'HEAD' && (fetchSite === 'cross-site' || fetchSite === 'same-site')) {
      throw new AppError('CROSS_SITE', 403, 'Requests from other sites are not accepted.');
    }
    req.user = await userForToken(db, readCookie(req.headers.cookie, SESSION_COOKIE));
    const path = req.url.split('?')[0];
    if (!req.user && !PUBLIC.some((re) => re.test(path))) {
      throw new AppError('UNAUTHENTICATED', 401, 'Please log in.');
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ code: err.code, message: err.message, details: err.details ?? null });
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ code: e.code ?? 'BAD_REQUEST', message: e.message ?? 'Bad request', details: null });
    }
    // Postgres-level guards (append-only, balance) surface here if code ever bypasses the posting engine.
    const msg = e.message ?? String(err);
    if (/append-only|unbalanced/.test(msg)) return reply.status(409).send({ code: 'LEDGER_GUARD', message: msg, details: null });
    console.error(err);
    return reply.status(500).send({ code: 'INTERNAL', message: 'Something went wrong. Check the server log.', details: null });
  });

  registerAuthRoutes(app, db);
  registerRoutes(app, db);

  if (opts.serveWeb && fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ code: 'NOT_FOUND', message: 'No such endpoint', details: null });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
