/* audit.js — append-only audit log helper */

import { stmts } from './db.js';

export function audit(req, action, target = null, details = null) {
  const user = req.user || {};
  try {
    stmts.insertAudit.run(
      Date.now(),
      user.id || null,
      user.username || null,
      req.ip || null,
      action,
      target,
      details ? JSON.stringify(details) : null,
    );
  } catch (e) {
    req.log?.error?.({ err: e }, 'audit log write failed');
  }
}
