/* =========================================================
   roles.js — permission-checking middleware.
   ========================================================= */

const ROLE_RANK = { starter: 1, operator: 2 };

export function requireAuth(req, reply, done) {
  if (!req.user) return reply.code(401).send({ error: 'not logged in' });
  done();
}

export function requireSuper(req, reply, done) {
  if (!req.user)         return reply.code(401).send({ error: 'not logged in' });
  if (!req.user.is_super) return reply.code(403).send({ error: 'super-operator only' });
  done();
}

export function requireRole(needed) {
  return function (req, reply, done) {
    if (!req.user) return reply.code(401).send({ error: 'not logged in' });
    if (req.user.is_super) return done();

    const serverName = req.params?.name;
    if (!serverName) return reply.code(400).send({ error: 'no server in route' });

    const have = req.user.permissions[serverName];
    if (!have) return reply.code(403).send({ error: 'no access to this server' });

    if (ROLE_RANK[have] < ROLE_RANK[needed]) {
      return reply.code(403).send({ error: `requires ${needed} role` });
    }
    done();
  };
}
