const jwt = require('jsonwebtoken');

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

function isSupabaseConfigured() {
  return !!SUPABASE_JWT_SECRET;
}

function verifySupabaseToken(token) {
  if (!SUPABASE_JWT_SECRET) {
    throw new Error('SUPABASE_JWT_SECRET not configured');
  }
  // Supabase signs access tokens HS256 with `aud=authenticated`.
  const payload = jwt.verify(token, SUPABASE_JWT_SECRET, {
    algorithms: ['HS256'],
    audience: 'authenticated'
  });
  return {
    sub: payload.sub,
    email: payload.email || (payload.user_metadata && payload.user_metadata.email) || null,
    name: (payload.user_metadata && (payload.user_metadata.full_name || payload.user_metadata.name)) || null,
    provider: payload.app_metadata && payload.app_metadata.provider,
    raw: payload
  };
}

function getAllowedDomains() {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS || '';
  return raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
}

function emailDomainAllowed(email) {
  const domains = getAllowedDomains();
  if (domains.length === 0) return true;
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.includes(domain);
}

module.exports = {
  isSupabaseConfigured,
  verifySupabaseToken,
  emailDomainAllowed,
  getAllowedDomains
};
