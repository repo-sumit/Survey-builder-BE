/**
 * GET /api/ready — public readiness probe.
 *
 * Distinct from /api/health:
 *   - /api/health    → "Express is up"     (liveness, DB-free, sub-ms)
 *   - /api/ready     → "Express + DB are up" (readiness, runs SELECT 1)
 *
 * Why a separate endpoint:
 *   - The FE warmup probe should hit /api/health (cheap, can't 503).
 *   - Orchestrators / deploy gates / synthetic monitors that need to know
 *     the API can actually serve requests should hit /api/ready, which
 *     fails closed (503) if the DB pool isn't reachable.
 *
 * Mounted AFTER the ensureDB middleware in app.js so the first hit pays
 * the one-time initStore() cost; subsequent hits become a single SELECT 1.
 * No auth required (this is what readiness checks need to be).
 * Response shape is a fixed contract — no env, secrets, stack, or version.
 */
const express = require('express');
const { pool } = require('../data/db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      db: 'ready',
      time: new Date().toISOString()
    });
  } catch (err) {
    // Fail closed: a 503 tells the orchestrator/monitor "do not route traffic".
    // We do NOT include err.message — it can contain DSN fragments.
    res.status(503).json({
      ok: false,
      db: 'unreachable',
      time: new Date().toISOString()
    });
  }
});

module.exports = router;
