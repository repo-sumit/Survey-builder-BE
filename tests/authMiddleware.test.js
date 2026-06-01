/**
 * Integration tests for middleware/auth.js — Supabase verifier error
 * translation contract.
 *
 * The middleware MUST map the verifier's stable error codes to HTTP:
 *   - .code === 'TRANSIENT_INFRA'  → 503 { error: 'AUTH_INFRA_TRANSIENT', … }
 *   - .code === 'INVALID_TOKEN'    → 401 (existing behavior preserved)
 *
 * The transient-infra 503 lets the FE keep the cached session and show a
 * reconnect banner; the 401 lets it purge as before. We also assert that
 * NO part of the underlying verifier error leaks into the response body —
 * not the stack, not env strings, not connection strings.
 *
 * Router is mounted on a bare Express app, with services/supabaseAuth and
 * data/store mocked, so the test never touches the real DB pool or the
 * real Supabase verifier.
 */
const express = require('express');
const request = require('supertest');

const VERIFIER_ERR_CODES = {
  TRANSIENT_INFRA: 'TRANSIENT_INFRA',
  INVALID_TOKEN: 'INVALID_TOKEN'
};

const FORBIDDEN_BODY_SUBSTRINGS = [
  'database_url',
  'process.env',
  'stack',
  'postgresql://',
  'jwt'
];

/**
 * Build a fresh middleware module backed by a controllable verifier and
 * store. Each test calls this so jest.resetModules + jest.doMock can wire
 * the doubles cleanly.
 */
function buildMiddlewareWithMocks({ verifierImpl, findUserByEmailImpl }) {
  jest.resetModules();

  jest.doMock('../services/supabaseAuth', () => ({
    isSupabaseConfigured: () => true,
    verifySupabaseToken: verifierImpl,
    emailDomainAllowed: () => true,
    ERR_TRANSIENT_INFRA: 'TRANSIENT_INFRA',
    ERR_INVALID_TOKEN: 'INVALID_TOKEN'
  }));

  jest.doMock('../data/store', () => ({
    findUserByEmail: findUserByEmailImpl || jest.fn().mockResolvedValue({
      id: 1,
      role: 'admin',
      stateCode: null,
      isActive: true,
      email: 'a@b.com',
      name: 'Alice',
      username: 'alice'
    }),
    findUserById: jest.fn(),
    touchUserLastLogin: jest.fn().mockResolvedValue(undefined)
  }));

  // eslint-disable-next-line global-require
  return require('../middleware/auth');
}

function buildApp(middleware) {
  const app = express();
  app.get('/api/test/me', middleware.requireAuth, (req, res) => {
    res.json({ user: req.user });
  });
  return app;
}

describe('middleware/auth.js — verifier error translation', () => {
  // Silence the console.warn the middleware emits for transient errors.
  let warnSpy;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  test('verifier .code = TRANSIENT_INFRA → route returns 503 AUTH_INFRA_TRANSIENT', async () => {
    const verifier = jest.fn().mockImplementation(() => {
      const err = new Error(VERIFIER_ERR_CODES.TRANSIENT_INFRA);
      err.code = VERIFIER_ERR_CODES.TRANSIENT_INFRA;
      throw err;
    });
    const middleware = buildMiddlewareWithMocks({ verifierImpl: verifier });
    const app = buildApp(middleware);

    const res = await request(app)
      .get('/api/test/me')
      .set('Authorization', 'Bearer some.token.value');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('AUTH_INFRA_TRANSIENT');
    expect(typeof res.body.message).toBe('string');
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  test('verifier .code = TRANSIENT_INFRA response body does not leak secrets', async () => {
    // Even if the underlying error message contained a DSN or stack
    // fragment, the middleware MUST NOT echo it into the response body.
    // We construct a verifier that throws with a deliberately leaky
    // .message to prove the middleware ignores it.
    const verifier = jest.fn().mockImplementation(() => {
      const err = new Error('postgresql://user:pass@host/db — see process.env.DATABASE_URL stack jwt secret');
      err.code = VERIFIER_ERR_CODES.TRANSIENT_INFRA;
      throw err;
    });
    const middleware = buildMiddlewareWithMocks({ verifierImpl: verifier });
    const app = buildApp(middleware);

    const res = await request(app)
      .get('/api/test/me')
      .set('Authorization', 'Bearer some.token.value');

    const serialized = JSON.stringify(res.body).toLowerCase();
    for (const needle of FORBIDDEN_BODY_SUBSTRINGS) {
      expect(serialized).not.toContain(needle);
    }
  });

  test('verifier .code = INVALID_TOKEN → route returns 401 (existing behavior preserved)', async () => {
    const verifier = jest.fn().mockImplementation(() => {
      const err = new Error(VERIFIER_ERR_CODES.INVALID_TOKEN);
      err.code = VERIFIER_ERR_CODES.INVALID_TOKEN;
      throw err;
    });
    const middleware = buildMiddlewareWithMocks({ verifierImpl: verifier });
    const app = buildApp(middleware);

    const res = await request(app)
      .get('/api/test/me')
      .set('Authorization', 'Bearer bad.token.value');

    expect(res.status).toBe(401);
    // The legacy 401 contract uses { error, message } via the fail() helper.
    expect(res.body.error).toBeTruthy();
  });

  test('verifier throws without .code → falls back to 401 (defensive default)', async () => {
    const verifier = jest.fn().mockImplementation(() => {
      throw new Error('some unexpected error');
    });
    const middleware = buildMiddlewareWithMocks({ verifierImpl: verifier });
    const app = buildApp(middleware);

    const res = await request(app)
      .get('/api/test/me')
      .set('Authorization', 'Bearer x.y.z');

    expect(res.status).toBe(401);
  });

  test('missing Authorization header still returns 401 (sanity)', async () => {
    const middleware = buildMiddlewareWithMocks({
      verifierImpl: jest.fn()
    });
    const app = buildApp(middleware);

    const res = await request(app).get('/api/test/me');
    expect(res.status).toBe(401);
  });
});
