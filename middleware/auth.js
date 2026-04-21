const jwt = require('jsonwebtoken');
const config = require('../config');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    // 2026-04-21: return 401 (not 403) for invalid/expired tokens.
    // 401 = credentials invalid → client should refresh token / re-auth.
    // 403 = credentials valid but wrong role → permission denied, no refresh.
    // Previously returning 403 caused fetchWithAuth (post Fix B 401/403 split)
    // to silently pass the error to the caller as a permission failure rather
    // than triggering token refresh + re-auth modal. Users hit an expired
    // token and saw "Invalid or expired token" toast with no recovery path.
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function authenticateAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function authenticateInternal(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!config.INTERNAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Internal staff access required' });
  }
  next();
}

module.exports = {
  authenticateToken,
  authenticateAdmin,
  authenticateInternal,
  INTERNAL_ROLES: config.INTERNAL_ROLES
};
