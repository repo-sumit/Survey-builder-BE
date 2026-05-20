const { insertAuditLog } = require('../data/store');

function logAudit(req, { action, entityType, entityId, metadata }) {
  if (!action) return;
  const user = req && req.user ? req.user : {};
  insertAuditLog({
    actorId: user.id,
    actorLabel: user.label || user.email || user.username || 'system',
    actorRole: user.role || 'unknown',
    stateCode: user.stateCode || null,
    action,
    entityType,
    entityId,
    metadata,
    ip: req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null) : null,
    userAgent: req ? (req.headers['user-agent'] || null) : null
  }).catch(err => {
    console.error('[audit] failed to record', action, err.message);
  });
}

module.exports = { logAudit };
