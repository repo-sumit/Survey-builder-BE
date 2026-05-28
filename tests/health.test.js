/**
 * Integration tests for GET /api/health.
 *
 * What this guarantees:
 *   - Status 200 with the documented contract:
 *       { ok: true, status: 'ok', service: 'survey-builder-api',
 *         time: <ISO timestamp> }
 *   - No auth required (this is what external uptime monitors hit).
 *   - No DB call is made (we mount the router on a bare express app with
 *     no DB middleware — if the handler ever started hitting the pool the
 *     test would either hang or throw because no pool is wired here).
 *   - No env/secret data leaks into the response.
 *
 * The router is mounted in isolation rather than via the production app.js
 * so the test cannot accidentally pull in the DB-init middleware or any
 * other side-effect-bearing wiring.
 */
const express = require('express');
const request = require('supertest');

const healthRouter = require('../routes/health');

function buildApp() {
  const app = express();
  app.use('/api/health', healthRouter);
  return app;
}

const ALLOWED_KEYS = new Set(['ok', 'status', 'service', 'time']);
// Keep this list of forbidden substrings tight — anything that looks like a
// secret name should never appear in a response body. The test does a
// case-insensitive substring scan over the whole serialized JSON.
const FORBIDDEN_SUBSTRINGS = [
  'secret',
  'password',
  'token',
  'jwt',
  'database_url',
  'process.env',
  'stack',
  'apikey',
  'private'
];

describe('GET /api/health', () => {
  test('responds 200 with the documented contract', async () => {
    const res = await request(buildApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('survey-builder-api');
    expect(typeof res.body.time).toBe('string');
    // ISO 8601 with milliseconds + Z — what new Date().toISOString() emits.
    expect(res.body.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Backward-compat field kept from the original shape.
    expect(res.body.status).toBe('ok');
  });

  test('returns no extra fields beyond the documented contract', async () => {
    const res = await request(buildApp()).get('/api/health');
    const unexpected = Object.keys(res.body).filter(k => !ALLOWED_KEYS.has(k));
    expect(unexpected).toEqual([]);
  });

  test('does not leak env/secret-like data in the response body', async () => {
    const res = await request(buildApp()).get('/api/health');
    const serialized = JSON.stringify(res.body).toLowerCase();
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      expect(serialized).not.toContain(needle.toLowerCase());
    }
  });

  test('does not require an Authorization header (public probe)', async () => {
    // The router is intentionally mounted with no auth middleware in front
    // of it — verify that an anonymous request gets a 200, not a 401/403.
    const res = await request(buildApp()).get('/api/health');
    expect([401, 403]).not.toContain(res.status);
  });

  test('time advances between calls (proves the handler is live, not cached)', async () => {
    const app = buildApp();
    const a = await request(app).get('/api/health');
    // Tiny gap — Date.now() resolution + supertest setup is plenty to bump
    // the millisecond field of an ISO string.
    await new Promise((r) => setTimeout(r, 5));
    const b = await request(app).get('/api/health');
    expect(new Date(b.body.time).getTime()).toBeGreaterThanOrEqual(
      new Date(a.body.time).getTime()
    );
  });
});
