/**
 * Integration tests for GET /api/ready.
 *
 * What this guarantees:
 *   - Status 200 with the documented contract `{ ok, db, time }` when the
 *     DB pool responds.
 *   - Status 503 (fail-closed) when the DB pool throws — monitors that
 *     gate traffic on readiness see the failure.
 *   - No env/secret data leaks into the response in either branch (the
 *     503 path in particular must NOT echo the pg error message, which
 *     can include DSN fragments).
 *   - No auth required.
 *
 * The router is mounted in isolation rather than via the production app.js
 * so the test can mock `data/db` cleanly and avoid side effects from the
 * ensureDB middleware.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../data/db', () => ({
  pool: { query: jest.fn() }
}));

const { pool } = require('../data/db');
const readyRouter = require('../routes/ready');

function buildApp() {
  const app = express();
  app.use('/api/ready', readyRouter);
  return app;
}

const ALLOWED_KEYS = new Set(['ok', 'db', 'time']);
const FORBIDDEN_SUBSTRINGS = [
  'secret',
  'password',
  'token',
  'jwt',
  'database_url',
  'postgres://',
  'postgresql://',
  'process.env',
  'stack',
  'apikey',
  'private'
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/ready', () => {
  test('returns 200 with { ok:true, db:"ready", time } when pool query succeeds', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const res = await request(buildApp()).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db).toBe('ready');
    expect(typeof res.body.time).toBe('string');
    expect(res.body.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });

  test('returns 503 with { ok:false, db:"unreachable", time } when pool throws', async () => {
    pool.query.mockRejectedValue(new Error('connect ECONNREFUSED — postgresql://user:hunter2@db/foo'));
    const res = await request(buildApp()).get('/api/ready');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db).toBe('unreachable');
    expect(typeof res.body.time).toBe('string');
  });

  test('returns no extra fields beyond the documented contract (success path)', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const res = await request(buildApp()).get('/api/ready');
    const unexpected = Object.keys(res.body).filter(k => !ALLOWED_KEYS.has(k));
    expect(unexpected).toEqual([]);
  });

  test('returns no extra fields beyond the documented contract (failure path)', async () => {
    pool.query.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get('/api/ready');
    const unexpected = Object.keys(res.body).filter(k => !ALLOWED_KEYS.has(k));
    expect(unexpected).toEqual([]);
  });

  test('does not leak env/secret-like data in the response body — success', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const res = await request(buildApp()).get('/api/ready');
    const serialized = JSON.stringify(res.body).toLowerCase();
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      expect(serialized).not.toContain(needle.toLowerCase());
    }
  });

  test('does not leak env/secret-like data in the response body — failure', async () => {
    // Critical: the error message contains a DSN. We must NOT echo it.
    pool.query.mockRejectedValue(new Error('postgresql://leaked:secret@host/db — process.env.DATABASE_URL'));
    const res = await request(buildApp()).get('/api/ready');
    const serialized = JSON.stringify(res.body).toLowerCase();
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      expect(serialized).not.toContain(needle.toLowerCase());
    }
  });

  test('does not require an Authorization header (public probe)', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const res = await request(buildApp()).get('/api/ready');
    expect([401, 403]).not.toContain(res.status);
  });
});
