/**
 * Unit tests for the `_shouldTouchLastLogin` throttle inside middleware/auth.js.
 *
 * This is a pure-memory throttle around the auth middleware's
 * `touchUserLastLogin` call — its only job is to skip the DB write when
 * the same user has already been touched within the last
 * LAST_LOGIN_THROTTLE_MS window. We don't bring up the full middleware
 * here because `requireAuth` would also pull in supabase JWT verification
 * and DB access; we exercise the throttle in isolation through the
 * private exports.
 *
 * Contract under test:
 *   - First call for a user returns true (write through).
 *   - Subsequent calls within the window return false (skip DB write).
 *   - Calls after the window elapses return true again.
 *   - Different users have independent throttle clocks.
 */
const {
  _shouldTouchLastLogin,
  _resetLastLoginThrottleForTests,
  LAST_LOGIN_THROTTLE_MS
} = require('../middleware/auth');

beforeEach(() => {
  _resetLastLoginThrottleForTests();
});

describe('touchUserLastLogin throttle', () => {
  test('first call for a user returns true', () => {
    expect(_shouldTouchLastLogin(1, 1_000_000)).toBe(true);
  });

  test('second call within the window returns false', () => {
    _shouldTouchLastLogin(1, 1_000_000);
    expect(_shouldTouchLastLogin(1, 1_000_000 + 1_000)).toBe(false);
    expect(_shouldTouchLastLogin(1, 1_000_000 + 60_000)).toBe(false);
  });

  test('call after the window elapses returns true again', () => {
    _shouldTouchLastLogin(1, 1_000_000);
    const justAfter = 1_000_000 + LAST_LOGIN_THROTTLE_MS;
    expect(_shouldTouchLastLogin(1, justAfter)).toBe(true);
  });

  test('different users have independent throttle clocks', () => {
    _shouldTouchLastLogin(1, 1_000_000);
    // User 2 is brand-new at the same instant — must write through.
    expect(_shouldTouchLastLogin(2, 1_000_000)).toBe(true);
    // User 1 still throttled.
    expect(_shouldTouchLastLogin(1, 1_000_000 + 1_000)).toBe(false);
  });

  test('throttle window matches the documented 10-minute interval', () => {
    expect(LAST_LOGIN_THROTTLE_MS).toBe(10 * 60 * 1000);
  });

  test('rapid burst of /me-style requests for one user writes once', () => {
    // Simulate the FE pattern that caused this throttle to exist:
    // boot + TOKEN_REFRESHED + retry + tab focus, all within ~30 s.
    const start = 1_700_000_000_000;
    const writes = [];
    for (const offsetMs of [0, 500, 5_000, 15_000, 30_000]) {
      if (_shouldTouchLastLogin(42, start + offsetMs)) writes.push(offsetMs);
    }
    expect(writes).toEqual([0]);
  });
});
