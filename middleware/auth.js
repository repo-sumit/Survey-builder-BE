const jwt = require('jsonwebtoken');
const {
  findUserByEmail,
  findUserById,
  touchUserLastLogin
} = require('../data/store');
const {
  isSupabaseConfigured,
  verifySupabaseToken,
  emailDomainAllowed
} = require('../services/supabaseAuth');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

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

async function trySupabaseJwt(token) {
  if (!isSupabaseConfigured()) return { ok: false };
  let claims;
  try {
    claims = await verifySupabaseToken(token);
  } catch (err) {
    // Verification failed (wrong signature, expired, unsupported alg, etc.)
    // — fall through to the legacy path.
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
  touchUserLastLogin(profile.id, claims.sub).catch(err => {
    console.error('touchUserLastLogin failed', err.message);
  });
  return { ok: true, profile };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return fail(res, 401, 'Authentication required');
  }
  const token = header.slice(7);

  // 1. Supabase path
  const supa = await trySupabaseJwt(token);
  if (supa.ok) {
    if (supa.reject) {
      return fail(res, supa.reject.status, supa.reject.error, supa.reject.message);
    }
    req.user = buildReqUser(supa.profile);
    return next();
  }

  // 2. Legacy path
  const legacyProfile = await tryLegacyJwt(token);
  if (legacyProfile) {
    if (!legacyProfile.isActive && legacyProfile.role !== 'admin') {
      // Inactive non-admin: allow read paths to flow; requireWriteAccess will block writes.
    }
    req.user = buildReqUser(legacyProfile);
    return next();
  }

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

module.exports = { requireAuth, requireAdmin, requireWriteAccess, JWT_SECRET };
