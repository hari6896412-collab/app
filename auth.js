const jwt = require('jsonwebtoken');
const db = require('./db');

function getAuthUser(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const payload = getAuthUser(req);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or missing token' });
  }

  // Always check live account state (passwords are never selected)
  const liveUser = db
    .prepare('SELECT id, login_id, username, access_level, status, centre_id, scope_id FROM users WHERE id = ?')
    .get(payload.id);

  if (!liveUser) {
    return res.status(401).json({ error: 'Account no longer exists' });
  }

  if (liveUser.status !== 'approved') {
    return res.status(403).json({
      error: `Account (ID ${liveUser.login_id}) is currently '${liveUser.status}'`,
    });
  }

  req.user = liveUser;
  next();
}

function requireLevel(...allowedLevels) {
  return (req, res, next) => {
    if (!req.user || !allowedLevels.includes(Number(req.user.access_level))) {
      const label =
        allowedLevels.length === 1
          ? `Level ${allowedLevels[0]} required`
          : 'insufficient access level';
      return res.status(403).json({ error: `Forbidden: ${label}` });
    }
    next();
  };
}

// Any admin: Super (0), Region (1), Zone (2) or Centre (3). Jurisdiction is checked inside each route.
const requireAdmin = requireLevel(0, 1, 2, 3);
const requireSuper = requireLevel(0);

module.exports = { getAuthUser, requireAuth, requireLevel, requireAdmin, requireSuper };