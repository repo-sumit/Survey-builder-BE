const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      username: payload.username,
      role: payload.role,
      stateCode: payload.stateCode,
      isActive: payload.isActive
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireWriteAccess(req, res, next) {
  if (req.user.role === 'admin') {
    return next();
  }
  if (!req.user.isActive) {
    return res.status(403).json({ error: 'Account is inactive. Read-only access.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireWriteAccess, JWT_SECRET };
