/**
 * GET /api/health — public liveness probe.
 *
 * Intentionally minimal:
 *   - No auth required (this is what external uptime monitors hit).
 *   - No DB query — must stay below ~1 ms even under cold start so that
 *     keep-awake pings do not contribute to Render's free-tier hour cap
 *     or amplify load on Postgres. A separate /api/keep-alive endpoint
 *     exists for the rare case we want to nudge the DB pool.
 *   - No env, secret, version, or stack data is returned. The response
 *     shape is a fixed contract: ok / status / service / time. Anything
 *     that could leak deployment topology stays out of this payload.
 *
 * See docs/UPTIME_MONITORING.md for how external monitors are configured.
 */
const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    ok: true,
    // `status` is retained for backward compatibility with the original
    // shape; external monitors (and the FE warmup probe) only check for
    // HTTP 200, but tooling that grepped for status === 'ok' still works.
    status: 'ok',
    service: 'survey-builder-api',
    time: new Date().toISOString()
  });
});

module.exports = router;
