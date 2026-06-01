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

/* ── Error categories ─────────────────────────────────────────────────── */
/**
 * Verifier errors are bucketed into exactly two categories so callers can
 * distinguish "this token is bad" from "we can't talk to the identity
 * provider right now". The two HTTP outcomes differ critically:
 *   - INVALID_TOKEN → 401, which the FE treats as authoritative and purges.
 *   - TRANSIENT_INFRA → 503, which the FE treats as recoverable; cached
 *     session is preserved and a reconnect banner is shown.
 *
 * Original error messages are intentionally NOT propagated — they can
 * contain DSN-like strings, internal hostnames, or stack traces.
 */
const ERR_TRANSIENT_INFRA = 'TRANSIENT_INFRA';
const ERR_INVALID_TOKEN = 'INVALID_TOKEN';

function makeVerifierError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/* ── JWKS fetch + cache (1h TTL, keyed by issuer) ─────────────────────── */
const jwksCache = new Map();
const JWKS_TTL_MS = 60 * 60 * 1000;

class JwksFetchError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'JwksFetchError';
    this.isJwksFetchError = true;
  }
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new JwksFetchError(`JWKS HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new JwksFetchError('JWKS parse error')); }
      });
    });
    req.on('timeout', () => req.destroy(new JwksFetchError('JWKS fetch timeout')));
    req.on('error', () => reject(new JwksFetchError('JWKS network error')));
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
  // Stage 1: decode header/payload to pick the verification path. A failure
  // here means the token itself is unparseable — INVALID_TOKEN.
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.payload) {
    throw makeVerifierError(ERR_INVALID_TOKEN);
  }
  const alg = decoded.header.alg;

  let payload;
  try {
    if (alg === 'HS256') {
      if (!SUPABASE_JWT_SECRET) {
        // Server misconfiguration → treat as INVALID_TOKEN so we don't
        // tell a caller that the upstream IdP is down when it isn't.
        throw makeVerifierError(ERR_INVALID_TOKEN);
      }
      payload = jwt.verify(token, SUPABASE_JWT_SECRET, {
        algorithms: ['HS256'],
        audience: 'authenticated'
      });
    } else if (alg === 'RS256' || alg === 'ES256') {
      const issuer = decoded.payload.iss;
      if (!issuer) {
        throw makeVerifierError(ERR_INVALID_TOKEN);
      }
      // JWKS fetch failures (HTTP non-200, timeout, network) propagate as
      // JwksFetchError and re-throw below as TRANSIENT_INFRA. Anything
      // else (jwt.verify failures, missing kid, unsupported alg) is a
      // token-level failure → INVALID_TOKEN.
      let keys = await getJwks(issuer);
      let jwk = keys.find(k => k.kid === decoded.header.kid);
      if (!jwk) {
        // Force a refresh in case Supabase rotated keys
        keys = await getJwks(issuer, true);
        jwk = keys.find(k => k.kid === decoded.header.kid);
      }
      if (!jwk) {
        throw makeVerifierError(ERR_INVALID_TOKEN);
      }
      const pem = jwkToPem(jwk);
      payload = jwt.verify(token, pem, {
        algorithms: [alg],
        audience: 'authenticated'
      });
    } else {
      throw makeVerifierError(ERR_INVALID_TOKEN);
    }
  } catch (err) {
    // Already categorised → re-throw as-is.
    if (err && (err.code === ERR_TRANSIENT_INFRA || err.code === ERR_INVALID_TOKEN)) {
      throw err;
    }
    // JWKS fetch errors → identity provider unreachable.
    if (err && err.isJwksFetchError) {
      throw makeVerifierError(ERR_TRANSIENT_INFRA);
    }
    // Everything else from jwt.verify (TokenExpiredError, JsonWebTokenError,
    // NotBeforeError, audience mismatch) is a token-level failure.
    throw makeVerifierError(ERR_INVALID_TOKEN);
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
  getAllowedDomains,
  ERR_TRANSIENT_INFRA,
  ERR_INVALID_TOKEN
};
