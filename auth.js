const jwt = require('jsonwebtoken');

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

function hasLevel(user, ...allowedLevels) {
  return Boolean(user && allowedLevels.includes(user.access_level));
}

module.exports = { getAuthUser, hasLevel };