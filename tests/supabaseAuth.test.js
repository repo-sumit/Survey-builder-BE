/**
 * Unit tests for services/supabaseAuth.js — error categorisation contract.
 *
 * verifySupabaseToken MUST throw errors with a stable .code:
 *   - 'TRANSIENT_INFRA' → JWKS HTTP non-200, JWKS network/timeout error.
 *   - 'INVALID_TOKEN'   → malformed token, bad signature, expired token,
 *                         missing claims, unsupported alg.
 *
 * The category is what the auth middleware uses to choose 401 vs 503; we
 * pin the contract here so future refactors can't silently turn a Supabase
 * blip into a forced logout.
 *
 * The thrown error MUST NOT leak the underlying err.message — those can
 * contain DSN-like content, internal hostnames, or stack traces. We assert
 * the message is only the code string.
 */
const jwt = require('jsonwebtoken');

// We need to control https.get before requiring the module under test
// because the JWKS cache is module-scoped. Use jest.resetModules so each
// test gets a clean cache and fresh mock state.
describe('verifySupabaseToken error categorisation', () => {
  const ORIGINAL_ENV = process.env;
  let httpsMock;
  let supabaseAuth;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Default to no HS256 secret so the asymmetric path is exercised.
    delete process.env.SUPABASE_JWT_SECRET;
    httpsMock = { get: jest.fn() };
    jest.doMock('https', () => httpsMock);
    supabaseAuth = require('../services/supabaseAuth');
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  /**
   * Build a fake https.get that invokes the response callback with a given
   * statusCode, then either emits 'end' or simulates timeout / error on the
   * request object. Returns the mock implementation.
   */
  function mockHttpsResponse({ statusCode = 200, body = '{"keys":[]}' } = {}) {
    return (_url, _opts, cb) => {
      const res = {
        statusCode,
        listeners: {},
        on(event, fn) { this.listeners[event] = fn; return this; },
        resume() { /* noop */ }
      };
      // Invoke cb synchronously with the response.
      setImmediate(() => {
        cb(res);
        if (statusCode === 200) {
          if (res.listeners.data) res.listeners.data(body);
          if (res.listeners.end) res.listeners.end();
        }
      });
      const req = {
        on() { return this; },
        destroy() { /* noop */ }
      };
      return req;
    };
  }

  function mockHttpsTimeout() {
    return (_url, _opts, _cb) => {
      const req = {
        _listeners: {},
        on(event, fn) { this._listeners[event] = fn; return this; },
        destroy(err) {
          // The real https request emits 'error' after destroy(err).
          if (this._listeners.error) {
            setImmediate(() => this._listeners.error(err));
          }
        }
      };
      // Fire timeout shortly so the verifier's .on('timeout', …) handler
      // can call req.destroy(new Error('JWKS fetch timeout')).
      setImmediate(() => {
        if (req._listeners.timeout) req._listeners.timeout();
      });
      return req;
    };
  }

  function mockHttpsNetworkError() {
    return (_url, _opts, _cb) => {
      const req = {
        _listeners: {},
        on(event, fn) { this._listeners[event] = fn; return this; },
        destroy() { /* noop */ }
      };
      setImmediate(() => {
        if (req._listeners.error) {
          req._listeners.error(new Error('ECONNREFUSED'));
        }
      });
      return req;
    };
  }

  /**
   * Build an RS256-style token by hand. We never reach signature
   * verification in JWKS-fetch-failure paths — the verifier bails inside
   * getJwks(), so an unsigned/garbage-signed token is fine for asserting
   * the TRANSIENT_INFRA categorisation.
   */
  function buildAsymmetricToken() {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const header = b64({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
    const payload = b64({
      iss: 'https://abc.supabase.co/auth/v1',
      sub: 'user-1',
      aud: 'authenticated'
    });
    return `${header}.${payload}.unverified-signature`;
  }

  test('JWKS HTTP non-200 → throws .code = TRANSIENT_INFRA', async () => {
    httpsMock.get.mockImplementation(mockHttpsResponse({ statusCode: 500 }));
    const token = buildAsymmetricToken();
    await expect(supabaseAuth.verifySupabaseToken(token))
      .rejects.toMatchObject({ code: 'TRANSIENT_INFRA' });
  });

  test('JWKS HTTP 503 → throws .code = TRANSIENT_INFRA', async () => {
    httpsMock.get.mockImplementation(mockHttpsResponse({ statusCode: 503 }));
    const token = buildAsymmetricToken();
    await expect(supabaseAuth.verifySupabaseToken(token))
      .rejects.toMatchObject({ code: 'TRANSIENT_INFRA' });
  });

  test('JWKS network timeout → throws .code = TRANSIENT_INFRA', async () => {
    httpsMock.get.mockImplementation(mockHttpsTimeout());
    const token = buildAsymmetricToken();
    await expect(supabaseAuth.verifySupabaseToken(token))
      .rejects.toMatchObject({ code: 'TRANSIENT_INFRA' });
  });

  test('JWKS network error (ECONNREFUSED) → throws .code = TRANSIENT_INFRA', async () => {
    httpsMock.get.mockImplementation(mockHttpsNetworkError());
    const token = buildAsymmetricToken();
    await expect(supabaseAuth.verifySupabaseToken(token))
      .rejects.toMatchObject({ code: 'TRANSIENT_INFRA' });
  });

  test('expired HS256 token → throws .code = INVALID_TOKEN', async () => {
    process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';
    jest.resetModules();
    jest.doMock('https', () => httpsMock);
    const fresh = require('../services/supabaseAuth');
    const expired = jwt.sign(
      { sub: 'user-1', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) - 60 },
      'unit-test-secret',
      { algorithm: 'HS256' }
    );
    await expect(fresh.verifySupabaseToken(expired))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  test('malformed token (garbage string) → throws .code = INVALID_TOKEN', async () => {
    await expect(supabaseAuth.verifySupabaseToken('not-a-jwt'))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  test('HS256 with wrong secret → throws .code = INVALID_TOKEN', async () => {
    process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';
    jest.resetModules();
    jest.doMock('https', () => httpsMock);
    const fresh = require('../services/supabaseAuth');
    const badSig = jwt.sign(
      { sub: 'user-1', aud: 'authenticated' },
      'a-different-secret',
      { algorithm: 'HS256' }
    );
    await expect(fresh.verifySupabaseToken(badSig))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  test('unsupported alg (none) → throws .code = INVALID_TOKEN', async () => {
    // Build a token with alg=none manually — jwt.sign refuses 'none' by
    // default. We just hand-craft the parts.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    const token = `${header}.${payload}.`;
    await expect(supabaseAuth.verifySupabaseToken(token))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  test('thrown error message does not leak underlying details', async () => {
    httpsMock.get.mockImplementation(mockHttpsResponse({ statusCode: 500 }));
    const token = buildAsymmetricToken();
    try {
      await supabaseAuth.verifySupabaseToken(token);
      throw new Error('expected verifier to throw');
    } catch (err) {
      // The message must be only the code string — no DSN, stack, or
      // internal details bleeding out.
      expect(err.message).toBe('TRANSIENT_INFRA');
      expect(err.message).not.toMatch(/https?:\/\//);
      expect(err.message).not.toMatch(/jwks/i);
      expect(err.message).not.toMatch(/stack/i);
    }
  });
});
