# Uptime Monitoring — Survey Builder Backend

This document explains why the backend needs an external keep-awake ping, how it is set up today (GitHub Actions on a 10-minute cron), and how to add or replace that with UptimeRobot or cron-job.org if you prefer.

---

## Why this exists

The Survey Builder backend runs on a **Render Free** instance. Render's free tier sleeps services after approximately **15 minutes of inactivity**. When a real user signs in and the FE makes its first API call to a sleeping instance, Render has to spin the container back up — typically **10–40 seconds**. During that wake-up window the FE displays the non-blocking banner:

> "Backend is reconnecting. You can keep viewing the app; saving may be temporarily unavailable."

The properly-engineered fix is to upgrade Render to a paid plan (Starter, Pro, or higher) where instances do not sleep. Until that upgrade happens, the workaround below keeps the instance warm by pinging a cheap health endpoint every 10 minutes from outside the BE itself.

> **Do not add a self-ping loop inside the backend.** A `setInterval(fetch(self/health))` would (a) not survive Render putting the container to sleep, and (b) generate fake internal load that masks real traffic in logs. Always ping from *outside* the BE.

---

## What endpoint we ping

`GET /api/health`

This route:
- is **public** (no auth header required),
- is **DB-free** — it is mounted *before* the DB-init middleware in `app.js`, so a ping does not wait on Postgres,
- returns the documented contract `{ ok, status, service, time }`,
- never exposes env vars, secrets, version numbers, or stack traces.

The endpoint is covered by `tests/health.test.js`, which asserts the contract and that no secret-like substrings ever appear in the body.

### Liveness vs readiness — `/api/health` vs `/api/ready`

There are **two** public probes. Pick the right one for your use case:

| Endpoint | Purpose | DB? | Fails closed? | When to use |
|---|---|---|---|---|
| `GET /api/health` | Liveness — "Express is up" | No (mounted before `ensureDB`) | No, returns 200 even if DB is down | Keep-awake pings, FE warmup, generic uptime monitors. **This is what the GH Actions workflow pings.** |
| `GET /api/ready`  | Readiness — "Express + DB are up" | Yes, runs `SELECT 1` | Yes, returns **503** when the pool is unreachable | Deploy gates, synthetic monitors, anything that should stop routing traffic when Postgres is sick. Use for monitors where you want to alert on DB outages, not just process crashes. |
| `GET /api/keep-alive` | Legacy DB ping (predates `/api/ready`) | Yes | Yes (503 on failure) | Preserved for back-compat; prefer `/api/ready` for new monitors. |

Both `/api/ready` and `/api/health` are public (no auth required), return only the documented contract fields, and never expose env, secret, version, or stack data — including in the failure path. `tests/ready.test.js` locks the contract and the no-secret-leak guarantee for `/api/ready`.

Do **not** repoint the GitHub Actions keep-awake workflow at `/api/ready` — that endpoint hits Postgres on every call, which would amplify DB load instead of just nudging Express. Keep keep-awake on `/api/health` and use `/api/ready` only for monitors that genuinely need to know about DB health.

---

## Recommended ping interval

**Every 10 minutes.** Rationale:
- Render Free sleeps after ~15 min idle, so 10 min keeps the instance warm with a comfortable buffer.
- Render Free has a **monthly instance-hour cap**. Pinging every minute would push idle time toward zero and risk hitting the cap before the month ends.
- Health pings show up in Render's access log. Slower cadence keeps the log readable for real traffic.

⚠️ **Do not ping more often than every 5 minutes.** Doing so consumes Render free-tier hours faster than necessary, can trigger Render's rate limits, and adds noise to your access logs.

---

## Option 1 (current) — GitHub Actions scheduled workflow

The workflow file lives at:

```
Survey-builder-BE/.github/workflows/keep-render-awake.yml
```

It runs every 10 minutes via `schedule.cron: "*/10 * * * *"`, can also be triggered manually from the Actions tab via `workflow_dispatch`, and only requires one repository secret:

| Secret name | Value |
|---|---|
| `BACKEND_HEALTH_URL` | `https://<your-render-backend>.onrender.com/api/health` |

### How to add the secret

1. Go to the repository on GitHub.
2. **Settings → Secrets and variables → Actions → New repository secret**.
3. Name: `BACKEND_HEALTH_URL`.
4. Value: the full URL — for example `https://survey-builder-be.onrender.com/api/health`.
5. Click **Add secret**.

The workflow reads it as `secrets.BACKEND_HEALTH_URL`, never logs the URL itself, and only echoes the HTTP status returned.

### Manually trigger the workflow once after deployment

After committing the workflow file and adding the secret, go to **Actions → Keep Render Backend Awake → Run workflow** and trigger it manually. This serves two purposes:

1. Confirms the secret is wired correctly (the run logs "OK — backend responded 200").
2. Sleeps the BE for ≤10 min before the next scheduled tick fires, so the first user request after deployment hits a warm instance.

### Behaviour on a cold-start ping

If the BE is asleep when the workflow runs, the curl may exceed the 20s timeout. The workflow logs a `::warning::` and exits 0 so the Actions tab does not turn red — the next 10-minute tick will succeed once Render has finished waking the container. This is intentional: one flaky tick is not an outage signal.

### To pause / disable

- Pause: rename the file to `*.yml.disabled` or delete it.
- Re-enable: restore the file. (Or comment out the `schedule:` block and keep `workflow_dispatch:` so it only runs on manual trigger.)

### Scheduled-Action quirks to know

GitHub disables scheduled workflows in repos that have had **no commit activity for 60 days**. If you ever stop pushing for two months, the keep-awake ping silently stops too. The fix is one of:
- a trivial commit to the repo (anything; even a docs typo), or
- a manual `workflow_dispatch` run.

Either re-enables the schedule. The workflow doc string mentions this so a future reader doesn't have to rediscover it.

---

## Option 2 — UptimeRobot

Free for up to 50 monitors. Useful if you also want alert emails / Slack notifications when the BE is genuinely down (the GH Actions workflow does not alert).

1. Sign in at [uptimerobot.com](https://uptimerobot.com/).
2. **+ New Monitor**.
3. Configure:

| Field | Value |
|---|---|
| Monitor Type | `HTTP(s)` |
| Friendly Name | `Survey Builder BE health` |
| URL | `https://<your-render-backend>.onrender.com/api/health` |
| Monitoring Interval | `10 minutes` (this is the minimum on the free plan) |
| Monitor Timeout | 30 seconds (covers cold-start wake-up) |
| Alert Contacts | Add your email / Slack webhook as desired |

4. Save. UptimeRobot will start pinging immediately.

If you keep both Option 1 (GitHub Actions) and Option 2 (UptimeRobot) active, the BE is pinged twice per 10-min window — still well within safe limits, and you get GH-side keep-awake plus UR-side alerting.

---

## Option 3 — cron-job.org

A simple free cron service with email alerts.

1. Sign in at [cron-job.org](https://cron-job.org/).
2. **+ Create cronjob**.
3. Configure:

| Field | Value |
|---|---|
| Title | `Survey Builder BE keep-awake` |
| URL | `https://<your-render-backend>.onrender.com/api/health` |
| Schedule | `Every 10 minutes` |
| Request method | `GET` |
| Request timeout | `30 s` |
| Notify on failure | optional |

4. Save. Cron-job.org will start firing on the chosen schedule.

---

## How to verify the monitor is working

After setting up any of the options above:

```bash
# 1. Hit the endpoint directly — should respond in well under a second
#    when the instance is warm.
curl -i https://<your-render-backend>.onrender.com/api/health

# 2. Expect HTTP/1.1 200 and a body like:
#    {"ok":true,"status":"ok","service":"survey-builder-api","time":"<ISO>"}

# 3. Check the chosen monitor:
#    - GitHub Actions: Repo → Actions → "Keep Render Backend Awake" → last run.
#    - UptimeRobot:    dashboard → monitor page → response-time graph.
#    - cron-job.org:   dashboard → history.
```

If you see consistent 200 responses every 10 min, the instance is being kept warm correctly.

---

## When to stop using this and upgrade Render instead

Move to a paid Render plan when **any** of these become true:

- Cold-start delays are happening anyway (e.g. monitor hours are off, or Render has changed its sleep window).
- The keep-awake ping is using a meaningful fraction of your Render free hours.
- You have real users hitting the API outside the monitor cadence and they still see the warm-up banner.
- You need full uptime SLA reporting (paid plans expose more metrics).

The free workaround is just that — a workaround. Production reliability beyond a low-traffic pilot deserves a paid instance.

---

## Things this monitoring does NOT do

- **Does not check the DB.** The endpoint is intentionally DB-free. A separate `/api/keep-alive` route exists for the rare case you want to nudge Postgres; if you ever wire a monitor at that path, expect occasional 503s during Supabase / Render maintenance.
- **Does not check business endpoints.** Survey CRUD, auth, etc. are not in the keep-awake path. Failure of those routes will not surface here. Add domain-specific synthetic monitors if you need that depth.
- **Does not alert by default (GH Actions only).** If you want pager-style alerts, layer UptimeRobot or cron-job.org notifications on top of (or instead of) the workflow.
