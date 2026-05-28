// LEGACY LOGIN — legacy JWT fallback is disabled. Only Supabase auth is honored.
// const jwt = require('jsonwebtoken');
const {
  // findUserByEmail and findUserById are still used by Supabase path
  findUserByEmail,
  // findUserById,   // only used by legacy path — disabled
  touchUserLastLogin
} = require('../data/store');
const {
  isSupabaseConfigured,
  verifySupabaseToken,
  emailDomainAllowed
} = require('../services/supabaseAuth');

// LEGACY LOGIN — kept for reference; not used while legacy login is disabled.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

/**
 * In-memory throttle for `touchUserLastLogin`.
 *
 * Before this throttle the auth middleware fired an UPDATE on every
 * authenticated request (the FE refreshes /me on boot, on TOKEN_REFRESHED,
 * and on retry — easily 10+ times in a normal session). On cold Render
 * dynos this UPDATE shares a slow connection pool with the user lookup
 * and contributes measurable latency to /api/auth/me.
 *
 * `last_login_at` is an audit hint — a stale value by up to 10 min is
 * acceptable. RBAC does not consult this column. Throttling here:
 *   - Skips the DB write when we've already written for this userId in
 *     the last LAST_LOGIN_THROTTLE_MS window.
 *   - Still runs the underlying call as fire-and-forget when not stale,
 *     so request latency is unaffected either way.
 *   - Lives entirely in process memory — bounded by user count.
 *     Stateless restarts (the common case on Render) flush the map, so
 *     the first /me after a restart always writes through. Acceptable.
 */
const LAST_LOGIN_THROTTLE_MS = 10 * 60 * 1000;
const lastLoginTouchedAt = new Map(); // userId → epoch ms of last write

function _shouldTouchLastLogin(userId, now = Date.now()) {
  const prev = lastLoginTouchedAt.get(userId);
  if (!prev || (now - prev) >= LAST_LOGIN_THROTTLE_MS) {
    lastLoginTouchedAt.set(userId, now);
    return true;
  }
  return false;
}
// Exposed for tests only. Not part of the public middleware contract.
function _resetLastLoginThrottleForTests() {
  lastLoginTouchedAt.clear();
}

function fail(res, status, error, message) {
  return res.status(status).json({ error, message: message || error });
}

function buildReqUser(profile) {
  return {
    id: profile.id,
    role: profile.role,
    stateCode: profile.stateCode,
    isActive: profile.isActive,
    email: profile.email,
    name: profile.name,
    username: profile.username,
    label: profile.label,
    supabaseUserId: profile.supabaseUserId
  };
}

/* LEGACY LOGIN — disabled. Kept commented for reference.
async function tryLegacyJwt(token) {
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (!payload || !payload.id) return null;
  return await findUserById(payload.id);
}
end LEGACY LOGIN */

async function trySupabaseJwt(token) {
  if (!isSupabaseConfigured()) return { ok: false };
  let claims;
  try {
    claims = await verifySupabaseToken(token);
  } catch (err) {
    // Verification failed (wrong signature, expired, unsupported alg, etc.)
    return { ok: false };
  }
  if (!claims || !claims.email) {
    return { ok: false, reason: 'NO_EMAIL_IN_TOKEN' };
  }
  if (!emailDomainAllowed(claims.email)) {
    return { ok: true, reject: { status: 403, error: 'DOMAIN_BLOCKED', message: 'Email domain not allowed.' } };
  }
  const profile = await findUserByEmail(claims.email);
  if (!profile) {
    return { ok: true, reject: { status: 403, error: 'NOT_INVITED', message: 'Your Google account is not invited.' } };
  }
  if (!profile.isActive) {
    return { ok: true, reject: { status: 403, error: 'INACTIVE', message: 'Account is inactive.' } };
  }
  // Best-effort: update last_login_at and link supabase_user_id.
  // Throttled to once per LAST_LOGIN_THROTTLE_MS per user so a chatty
  // /me caller (boot + TOKEN_REFRESHED + retry + tab focus, all within
  // seconds) doesn't fire 5+ UPDATEs against the same row. RBAC does
  // not depend on last_login_at; a 10-minute staleness is fine.
  if (_shouldTouchLastLogin(profile.id)) {
    touchUserLastLogin(profile.id, claims.sub).catch(err => {
      console.error('touchUserLastLogin failed', err.message);
    });
  }
  return { ok: true, profile };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return fail(res, 401, 'Authentication required');
  }
  const token = header.slice(7);

  // 1. Supabase path (only auth path now)
  const supa = await trySupabaseJwt(token);
  if (supa.ok) {
    if (supa.reject) {
      return fail(res, supa.reject.status, supa.reject.error, supa.reject.message);
    }
    req.user = buildReqUser(supa.profile);
    return next();
  }

  /* LEGACY LOGIN — fallback path disabled. Kept commented for reference.
  const legacyProfile = await tryLegacyJwt(token);
  if (legacyProfile) {
    req.user = buildReqUser(legacyProfile);
    return next();
  }
  end LEGACY LOGIN */

  return fail(res, 401, 'Invalid or expired token');
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireWriteAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role === 'admin') {
    return next();
  }
  if (!req.user.isActive) {
    return res.status(403).json({ error: 'Account is inactive. Read-only access.' });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireWriteAccess,
  JWT_SECRET,
  // Throttle internals — exported solely for unit-test reach-in. Treat as
  // private; do not import from production code.
  _shouldTouchLastLogin,
  _resetLastLoginThrottleForTests,
  LAST_LOGIN_THROTTLE_MS
};
