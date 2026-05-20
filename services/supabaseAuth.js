const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

function isSupabaseConfigured() {
  // We always try Supabase verification when a bearer token is present;
  // the verifier itself picks HS256 vs JWKS-asymmetric based on the token header.
  // Returning true allows the middleware to attempt Supabase paths.
  return true;
}

/* ── JWKS fetch + cache (1h TTL, keyed by issuer) ─────────────────────── */
const jwksCache = new Map();
const JWKS_TTL_MS = 60 * 60 * 1000;

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`JWKS HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('JWKS fetch timeout')));
    req.on('error', reject);
  });
}

async function getJwks(issuer, forceRefresh = false) {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt) < JWKS_TTL_MS) {
    return cached.keys;
  }
  const url = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  const data = await httpsGetJson(url);
  const keys = data.keys || [];
  jwksCache.set(issuer, { keys, fetchedAt: Date.now() });
  return keys;
}

function jwkToPem(jwk) {
  const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return keyObject.export({ type: 'spki', format: 'pem' });
}

/* ── Token verification ───────────────────────────────────────────────── */

async function verifySupabaseToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.payload) {
    throw new Error('Malformed token');
  }
  const alg = decoded.header.alg;

  let payload;
  if (alg === 'HS256') {
    if (!SUPABASE_JWT_SECRET) {
      throw new Error('SUPABASE_JWT_SECRET not configured');
    }
    payload = jwt.verify(token, SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
      audience: 'authenticated'
    });
  } else if (alg === 'RS256' || alg === 'ES256') {
    const issuer = decoded.payload.iss;
    if (!issuer) {
      throw new Error('Token has no iss claim — cannot resolve JWKS');
    }
    let keys = await getJwks(issuer);
    let jwk = keys.find(k => k.kid === decoded.header.kid);
    if (!jwk) {
      // Force a refresh in case Supabase rotated keys
      keys = await getJwks(issuer, true);
      jwk = keys.find(k => k.kid === decoded.header.kid);
    }
    if (!jwk) {
      throw new Error(`No matching JWK for kid=${decoded.header.kid}`);
    }
    const pem = jwkToPem(jwk);
    payload = jwt.verify(token, pem, {
      algorithms: [alg],
      audience: 'authenticated'
    });
  } else {
    throw new Error(`Unsupported JWT algorithm: ${alg}`);
  }

  return {
    sub: payload.sub,
    email: payload.email || (payload.user_metadata && payload.user_metadata.email) || null,
    name: (payload.user_metadata && (payload.user_metadata.full_name || payload.user_metadata.name)) || null,
    provider: payload.app_metadata && payload.app_metadata.provider,
    raw: payload
  };
}

/* ── Domain allow-list ────────────────────────────────────────────────── */

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
