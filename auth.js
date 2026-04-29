/* =========================================================
   auth.js — passwords, sessions, request decorators.
   ========================================================= */

import argon2 from 'argon2';
import crypto from 'node:crypto';
import { stmts } from './db.js';

const SESSION_COOKIE = 'dash_session';
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE || '604800000', 10);

export function hashPassword(plain) {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash, plain) {
  try { return await argon2.verify(hash, plain); }
  catch { return false; }
}

function newSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

export function createSession(reply, userId) {
  const id = newSessionId();
  const now = Date.now();
  stmts.insertSession.run(id, userId, now, now + SESSION_MAX_AGE);

  reply.setCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    secure:   true,
    sameSite: 'lax',
    path:     '/',
    signed:   true,
    maxAge:   Math.floor(SESSION_MAX_AGE / 1000),
  });
  return id;
}

export function destroySession(req, reply) {
  const sid = readSessionId(req);
  if (sid) stmts.deleteSession.run(sid);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function readSessionId(req) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export async function loadUserFromCookie(req) {
  const sid = readSessionId(req);
  if (!sid) return;

  const session = stmts.getSession.get(sid, Date.now());
  if (!session) return;

  const user = stmts.getUserById.get(session.user_id);
  if (!user) return;

  const perms = stmts.getPermissionsForUser.all(user.id);
  const permMap = {};
  for (const p of perms) permMap[p.server_name] = p.role;

  req.user = {
    id:          user.id,
    username:    user.username,
    is_super:    !!user.is_super,
    permissions: permMap,
    sessionId:   sid,
  };
}
