/* routes/auth.js — login, logout, whoami */

import { stmts } from '../db.js';
import { verifyPassword, createSession, destroySession, hashPassword } from '../auth.js';
import { audit } from '../audit.js';
import { requireAuth } from '../roles.js';

const FAILS = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

function checkRate(ip) {
  const now = Date.now();
  const entry = FAILS.get(ip);
  if (!entry || now - entry.first > WINDOW_MS) {
    FAILS.set(ip, { first: now, count: 0 });
    return true;
  }
  return entry.count < MAX_FAILS;
}
function bumpRate(ip)  { const e = FAILS.get(ip); if (e) e.count++; }
function clearRate(ip) { FAILS.delete(ip); }

export default async function (app) {
  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    if (!checkRate(ip)) return reply.code(429).send({ error: 'too many failed attempts' });

    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      bumpRate(ip);
      return reply.code(400).send({ error: 'bad credentials' });
    }

    const user = stmts.getUserByUsername.get(username);
    if (!user) {
      bumpRate(ip);
      return reply.code(401).send({ error: 'bad credentials' });
    }

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      bumpRate(ip);
      audit({ ip, user: { username } }, 'login.failed', username);
      return reply.code(401).send({ error: 'bad credentials' });
    }

    clearRate(ip);
    createSession(reply, user.id);
    audit({ ip, user: { id: user.id, username: user.username } }, 'login.success');
    return { ok: true };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    audit(req, 'logout');
    destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    return {
      username:    req.user.username,
      is_super:    req.user.is_super,
      permissions: req.user.permissions,
    };
  });

  app.post('/api/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string' || next.length < 6) {
      return reply.code(400).send({ error: 'new password must be at least 6 chars' });
    }

    const row = stmts.getUserById.get(req.user.id);
    const ok  = await verifyPassword(row.password_hash, current);
    if (!ok) return reply.code(401).send({ error: 'current password wrong' });

    const hash = await hashPassword(next);
    stmts.updateUserPassword.run(hash, Date.now(), req.user.id);
    audit(req, 'password.changed');
    return { ok: true };
  });
}
