# Survey Builder Backend (`fmb-survey-builder-server`)

Node.js + Express REST API that powers the **FMB Survey Builder** platform. It owns:

- **Authentication & RBAC** (JWT, admin vs state, active vs inactive).
- **Survey + Question persistence** (PostgreSQL JSONB).
- **Concurrency control** (15-minute survey edit locks).
- **Excel/CSV import + export pipelines** (with a two-phase preview/commit flow and a read-only Dumpsheet Validator).
- **Validation engine** for survey payloads and uploaded files (single source of truth).
- **Supporting masters** — designation hierarchy, latest access-sheet dump, state config.
- **Translation proxy** to LibreTranslate.

> **Companion service**: the React frontend in [`../Survey-builder-FE`](../Survey-builder-FE).
> **Project-wide overview**: see the [root README](../README.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Key Features](#key-features)
3. [Tech Stack](#tech-stack)
4. [Repository Structure](#repository-structure)
5. [Architecture](#architecture)
6. [Application Logic](#application-logic)
7. [API Documentation](#api-documentation)
8. [Database / Data Model](#database--data-model)
9. [Environment Variables](#environment-variables)
10. [Installation & Local Setup](#installation--local-setup)
11. [Running the Project](#running-the-project)
12. [Testing](#testing)
13. [Deployment](#deployment)
14. [Security & Permissions](#security--permissions)
15. [Error Handling & Logging](#error-handling--logging)
16. [Known Constraints](#known-constraints)
17. [Future Improvements](#future-improvements)
18. [Contribution Guidelines](#contribution-guidelines)

---

## Overview

A single Express app exposes everything under `/api`. Data is stored in a PostgreSQL database that the service initialises itself on first boot — no separate migration tool is required.

The backend supports two deployment styles out of the box:
- **Vercel serverless** — `vercel.json` rewrites every request to `app.js`, plus a daily cron pings `/api/keep-alive` to keep cloud Postgres providers from auto-pausing.
- **Long-lived Node process** — when `process.env.VERCEL` is unset, `app.listen(PORT)` runs as expected (Render-style hosting).

---

## Key Features

- **JWT auth** with bcrypt-hashed passwords. 24-hour token lifetime.
- **Role-based access control** — `admin` (global) vs `state` (own state, write-gated by `is_active`).
- **State-scoped reads/writes** — non-admins only see surveys whose `state_code` matches their user.
- **Survey + Question CRUD** with idempotent upserts.
- **15-minute concurrency locks** with auto-cleanup; `409` on conflict.
- **Subtree-aware question duplication** — duplicating `Q2.1` as `Q3` clones `Q2.1.1 → Q3.1`, `Q2.1.2 → Q3.2`, including `OptionXChildren` references.
- **Excel/CSV import** — three modes:
  - `POST /api/import/preview` — parse + validate, return everything, persist nothing.
  - `POST /api/import` — parse + validate + persist (optional `surveyIds=` filter, optional `overwrite=true`).
  - `POST /api/import/validate-dump` — parse + validate; return errors only for rows whose `Mode` is `Correction` or `New Data`. Persists nothing.
- **Excel export** — single-survey XLSX dump via `GET /api/export/:surveyId`.
- **Validation engine** — `validation/validationEngine.js` is the canonical rule set, used by CRUD, duplicate, and all import flows.
- **Designation hierarchy** — per-state, per-language CRUD with seed defaults and XLSX export.
- **Access sheet dump** — XLSX BLOB persisted in `access_sheet_latest_dump`, downloadable via the API.
- **Translation proxy** — `POST /api/translate` proxies to LibreTranslate (configurable URL/key/timeout).
- **Publish / Unpublish** — feature-flagged; admins only for unpublish.
- **Auto SSL detection** — Postgres SSL turns on automatically for popular cloud providers (Supabase, Neon, Railway, Render, Cockroach, Cloud SQL) or when `NODE_ENV=production`.
- **Vercel keep-alive cron** — `0 8 * * *` daily ping prevents free-tier database pauses.

---

## Tech Stack

| Concern | Library |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4.18 |
| Database | PostgreSQL via `pg` 8 (JSONB columns) |
| Auth | `jsonwebtoken` |
| Hashing | `bcryptjs` |
| Uploads | `multer` (10 MB default cap) |
| XLSX | `exceljs` |
| CSV | `csv-parse` |
| Compression | `compression` (gzip) |
| Config | `dotenv` |
| Dev | `nodemon` |

No test framework or linter is configured today.

---

## Repository Structure

```
Survey-builder-BE/
├── app.js                        # Express bootstrap + route mounting + lazy DB init
├── package.json                  # Scripts (start, dev) + dependencies
├── vercel.json                   # Serverless rewrites + daily keep-alive cron
│
├── data/
│   ├── db.js                     # pg.Pool, idempotent initDB(), admin seed, SSL auto-detect
│   └── store.js                  # All SQL: surveys/questions/locks CRUD, helpers
│
├── middleware/
│   └── auth.js                   # requireAuth, requireAdmin, requireWriteAccess
│
├── routes/
│   ├── auth.js                   # POST /auth/login
│   ├── surveys.js                # Surveys + questions CRUD, locking, publish, duplication
│   ├── admin.js                  # User & state-config admin CRUD
│   ├── export.js                 # GET /export/:surveyId → XLSX
│   ├── import.js                 # /import, /import/preview, /import/validate-dump
│   ├── validateUpload.js         # POST /validate-upload (legacy/standalone validator)
│   ├── validationSchema.js       # GET /validation-schema → schema JSON for the FE
│   ├── translate.js              # POST /translate (LibreTranslate proxy)
│   ├── designations.js           # Designation hierarchy CRUD + XLSX export + seed
│   └── accessSheet.js            # Access sheet dump/upload/download
│
├── services/
│   ├── validator.js              # Thin facade over validationEngine.js
│   ├── excelGenerator.js         # ExcelJS workbook generation for export
│   └── accessSheetUtils.js       # Helpers used by accessSheet route
│
├── schemas/validationRules.js    # Constants/enums (question types, modes, etc.)
├── validation/validationEngine.js# Canonical validation rules — single source of truth
├── uploads/                      # Runtime upload staging (gitignored)
└── README.md                     # this file
```

---

## Architecture

### Layering

```
HTTP request
  → middleware/auth.js     (JWT verify, role gating)
  → routes/<domain>.js     (input parsing + response shape)
  → services/validator.js  → validation/validationEngine.js
  → data/store.js          (parameterised SQL only)
  → pg Pool                (PostgreSQL)
```

### Request lifecycle

1. `app.js` initialises `cors`, `compression`, `body-parser`.
2. A custom middleware lazily runs `initStore()` on the first request to handle Vercel cold starts.
3. Public routes: `GET /api/health`, `GET /api/keep-alive`, `POST /api/auth/login`.
4. All other routes pass through `requireAuth`; admin-only ones add `requireAdmin`; write-protected ones add `requireWriteAccess`.
5. Routes call helpers in `data/store.js` — no SQL is embedded in route files.
6. Mutations validate via `validation/validationEngine.js`. Surveys CRUD adds a lock check on `PUT`.

### Lazy DB initialisation

`app.js` keeps a process-level `dbInitPromise` so that the first request triggers `initStore()` once on cold-start. Subsequent requests skip it. Initialisation failures return `503 { error: 'Database unavailable' }`.

---

## Application Logic

### Survey identity & state scope
- `surveys.survey_id` is the primary key. `state_code` is nullable but enforced for non-admin reads/writes.
- `verifySurveyAccess(survey, user)` returns `false` for state users whose `stateCode` doesn't match `survey.stateCode`; routes return `403`.

### Question identity
- Composite primary key: `(survey_id, question_id)`.
- `question_id` must match `^Q\d+(\.\d+)*$`. Dots indicate child relationships.
- Child question's `sourceQuestion` is auto-derivable by stripping the last segment (FE convenience; BE stores whatever the client sends).

### Concurrency locking
- `POST /api/surveys/:id/lock` inserts/refreshes a row in `survey_locks` valid for 15 minutes.
- `PUT /api/surveys/:id` aborts with `409` when another user owns the lock.
- Expired locks are cleaned up lazily.

### Validation engine highlights (`validation/validationEngine.js`)
- Required survey fields: `surveyId`, `surveyName`, `surveyDescription`, `availableMediums`.
- Required question fields: `questionId`, `surveyId`, `medium`, `questionType`, `questionDescription`.
- `tableHeaderValue` must be exactly two comma-separated tokens for tabular question types.
- `tableQuestionValue` is **optional**; when present it must match `^[A-Za-z]:.*(\n[A-Za-z]:.*)*$`. Literal `\n` is normalised to a real newline before testing.
- Multiple-choice variants require ≥ 1 option (max 20, each ≤ 100 chars).
- `_validateChildMandatory` enforces that a child question can only be `isMandatory='Yes'` when its parent is too.
- `_validateChildMappings` blocks the same child ID being claimed by multiple options/parents.
- The `_validateChildParentType` rule ("Only Multiple Choice Single Select questions can have child questions") was removed in favour of fewer false positives. (See [Known Constraints](#known-constraints).)

### Import pipeline (`routes/import.js`)
- A shared `parseAndValidate(req)` helper extracts both XLSX (ExcelJS) and CSV (`csv-parse`) parsing plus validation into one place. Three endpoints reuse it:
  - `POST /api/import/preview` — returns `{ surveys, questions, validationErrors }`. Persists nothing.
  - `POST /api/import` — same, but applies an optional `surveyIds=` filter and an `overwrite=true` switch before upserting in batches.
  - `POST /api/import/validate-dump` — returns errors filtered to rows whose `mode` is `Correction` or `New Data`. Persists nothing.
- **Normalisations performed during parse**:
  - `isMandatory` → empty becomes `'No'`.
  - `mode` → case-insensitive (`new data`, `New Data`, `NEW DATA` all collapse to `'New Data'`).
  - `tableQuestionValue` → literal `\n` becomes a real newline.
  - `textInputType` typos (`numaric`, etc.) collapsed to canonical values.
- Each error includes a `cell` reference (e.g. `[Question Master B5]`) and the offending `field`.

### Export pipeline
- `GET /api/export/:surveyId` builds an XLSX with `services/excelGenerator.js` and streams it back to the client.

### Question duplication subtree
- `POST /api/surveys/:surveyId/questions/:questionId/duplicate` clones the source question **and all descendants**, remapping IDs and `OptionXChildren` references. Collisions with existing IDs return `400` listing every conflict.

### Publish lifecycle
- Stored in `surveys.publish` JSONB (`{"status": "DRAFT" | "PUBLISHED", publishedAt, publishedBy}`).
- Gated by `FEATURE_PUBLISH=true`.
- Question-master mutations are blocked when the survey is published.

---

## API Documentation

> All routes are mounted under `/api`. Every protected route requires `Authorization: Bearer <jwt>` unless noted.

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check. Returns `{ status: "ok", message }`. |
| `GET` | `/api/keep-alive` | Pings PostgreSQL (`SELECT NOW()`). Used by Vercel daily cron. |
| `POST` | `/api/auth/login` | Body: `{ username, password }` → `{ token, user }`. |

### Surveys (`/api/surveys`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/` | requireAuth | List surveys (state-scoped for non-admin). |
| `GET` | `/:id` | requireAuth | Fetch by ID (state-scoped). |
| `POST` | `/` | requireWriteAccess | Create. Validated. State-scoped force-stamping for non-admins. |
| `PUT` | `/:id` | requireWriteAccess | Update. Lock-aware. Forbidden when published. |
| `DELETE` | `/:id` | requireWriteAccess | Delete + cascade-delete questions. |
| `POST` | `/:id/duplicate` | requireWriteAccess | Duplicate the survey + (optional) its questions. |
| `POST` | `/:id/lock` | requireWriteAccess | Acquire a 15-minute edit lock. |
| `DELETE` | `/:id/lock` | requireWriteAccess | Release the lock if owned. |
| `GET` | `/:id/lock` | requireAuth | Lock status. |
| `POST` | `/:id/publish` | requireWriteAccess | Feature-flagged. |
| `POST` | `/:id/unpublish` | requireAdmin | Admin only. |

### Questions (sub-resource of surveys)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/surveys/:surveyId/questions` | requireAuth | All questions for a survey. |
| `POST` | `/api/surveys/:surveyId/questions` | requireWriteAccess | Create. |
| `PUT` | `/api/surveys/:surveyId/questions/:questionId` | requireWriteAccess | Update. |
| `DELETE` | `/api/surveys/:surveyId/questions/:questionId` | requireWriteAccess | Delete. |
| `POST` | `/api/surveys/:surveyId/questions/:questionId/duplicate` | requireWriteAccess | Subtree clone with remapped IDs. |

### Admin (`/api/admin`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/admin/users` | requireAdmin | List users. |
| `POST` | `/admin/users` | requireAdmin | Create user (bcrypt hash). |
| `PATCH` | `/admin/users/:id` | requireAdmin | Update role/state/active/password. |
| `GET` | `/admin/state-config` | requireAdmin | List state configurations. |
| `POST` | `/admin/state-config` | requireAdmin | Upsert. |
| `PATCH` | `/admin/state-config/:stateCode` | requireAdmin | Update one. |
| `DELETE` | `/admin/state-config/:stateCode` | requireAdmin | Delete. |

### Import / Export (`/api/import`, `/api/export`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/import/preview` | Parse + validate, return `surveys`, `questions`, `validationErrors`. No persistence. |
| `POST` | `/api/import` | Parse + validate + upsert. Query: `overwrite=true` to replace duplicates; `surveyIds=A,B,C` to import only those. |
| `POST` | `/api/import/validate-dump` | Parse + validate. Return errors only for rows whose `Mode` is `Correction` or `New Data`. No persistence. |
| `GET` | `/api/export/:surveyId` | Stream survey XLSX dump. |

### Validation utilities

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/validate-upload` | Validate an uploaded file standalone. |
| `GET` | `/api/validation-schema` | Return the validation schema as JSON (used by FE to render rules). |

### Designations (`/api/designations`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/?stateCode=&activeOnly=true` | List designations. |
| `POST` | `/` | Create (admin). |
| `PATCH` | `/:designationId` | Update (admin). |
| `DELETE` | `/:designationId` | Delete (admin). |
| `POST` | `/seed-defaults` | Seed defaults. |
| `GET` | `/export` | XLSX dump. |

### Access sheet (`/api/access-sheet`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/dump` | Generate / refresh latest dump for a state. |
| `GET` | `/latest?stateCode=XX` | Latest dump metadata. |
| `GET` | `/latest/download?stateCode=XX` | Download latest dump as XLSX. |
| `POST` | `/upload` | Upload an XLSX dump (validated). |

### Translate (`/api/translate`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/` | Body: `{ text, source, target }`. Proxies to LibreTranslate. |

### Authentication

```bash
curl -X POST http://localhost:5001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

Successful response:

```json
{
  "token": "<jwt>",
  "user": { "id": 1, "username": "admin", "role": "admin", "stateCode": null, "isActive": true }
}
```

---

## Database / Data Model

DDL lives in `data/db.js` and runs idempotently at startup (`CREATE TABLE IF NOT EXISTS …`). All inserts/updates go through `data/store.js`; SQL is parameterised.

### Tables

| Table | Primary Key | Notable columns |
|---|---|---|
| `surveys` | `survey_id` | `state_code`, `data` JSONB, `publish` JSONB (`{"status":"DRAFT"}` default), `created_at`, `updated_at` |
| `questions` | `(survey_id, question_id)` | `data` JSONB, `created_at`, `updated_at`. `ON DELETE CASCADE` from `surveys`. |
| `users` | `id` (serial) | `username` UNIQUE, `password` (bcrypt), `role` (`admin`/`state`), `state_code` nullable, `is_active` boolean. |
| `survey_locks` | `survey_id` | `locked_by` → `users.id`, `locked_at`, `expires_at`. |
| `designation_hierarchy` | `id` | `state_code`, `designation_id`, `hierarchy_level`, `designation_name`, `medium`, `medium_in_english`, `is_active`, `created_by`, `updated_by`. UNIQUE `(state_code, medium_in_english, hierarchy_level)`. |
| `state_config` | `state_code` | `state_name`, `available_languages` (CSV string). |
| `access_sheet_latest_dump` | `state_code` | `dumped_at`, `dumped_by`, `file_name`, `mime_type`, `file_bytes` BYTEA, `summary` JSONB. |

### Indexes

```
idx_surveys_state_code   ON surveys(state_code)
idx_questions_survey_id  ON questions(survey_id)
idx_designation_state    ON designation_hierarchy(state_code)
idx_users_username       ON users(username)
```

### Inline migrations

`initDB()` runs a few defensive `ALTER` statements on every boot so older databases don't break:
- `designation_hierarchy.designation_id` is allowed to be NULL.
- The legacy `(state_code, designation_id)` UNIQUE constraint is dropped if present.
- New columns (`state_code`, `publish`, `created_at`, `updated_at`) are added to `surveys` if missing.

### Admin seed

If `SEED_ADMIN_USER` and `SEED_ADMIN_PASSWORD` are both present and the user does not already exist, `initDB()` inserts an admin with bcrypt-hashed credentials.

---

## Environment Variables

> **Note:** there is no `.env.example` file in the repository (despite older docs referencing one). Create `.env` manually using the table below. Never commit it.

| Variable | Required | Default | Where used | Purpose |
|---|---|---|---|---|
| `DATABASE_URL` | Yes | `postgresql://postgres:postgres@localhost:5432/fmb_survey_builder` | `data/db.js` | PostgreSQL connection string. |
| `JWT_SECRET` | Yes (prod) | `dev-secret-change-in-production` *(Inferred)* | `routes/auth.js`, `middleware/auth.js` | HMAC key for JWT signing/verification. |
| `PORT` | No | `5001` | `app.js` | HTTP port for `npm start`. |
| `SEED_ADMIN_USER` | No | — | `data/db.js` | Username for first-boot admin seed. |
| `SEED_ADMIN_PASSWORD` | No | — | `data/db.js` | Password for first-boot admin seed. |
| `FEATURE_PUBLISH` | No | `false` | `routes/surveys.js` | Enables publish/unpublish endpoints when `true`. |
| `NODE_ENV` | No | `development` | `data/db.js` | `production` forces SSL on PostgreSQL. |
| `DB_SSL` | No | auto | `data/db.js` | Force-enable SSL (`true` / `false`). |
| `TRANSLATE_API_URL` | No | `https://libretranslate.de/translate` | `routes/translate.js` | Upstream translation backend. |
| `TRANSLATE_API_KEY` | No | — | `routes/translate.js` | Optional API key. |
| `TRANSLATE_TIMEOUT_MS` | No | `10000` | `routes/translate.js` | Timeout (ms). |
| `IMPORT_MAX_FILE_SIZE_MB` | No | `10` | `routes/import.js` | Multer upload cap. |
| `IMPORT_MAX_ROWS` | No | `10000` | `routes/import.js` | Hard row cap per file. |
| `IMPORT_UPSERT_BATCH_SIZE` | No | `25` | `routes/import.js` | Concurrency for `Promise.all` upserts. |
| `VERCEL` | No | (auto) | `app.js`, `data/db.js` | Detected at runtime to switch into serverless mode. |

---

## Installation & Local Setup

### Prerequisites
- Node.js 18+ (16 minimum)
- npm 8+
- PostgreSQL 13+ (local or cloud)

### Setup

```bash
cd Survey-builder-BE

# 1. Create .env (no .env.example shipped). Suggested minimum:
cat > .env <<'ENV'
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fmb_survey_builder
JWT_SECRET=replace-with-a-long-random-string
PORT=5001
SEED_ADMIN_USER=admin
SEED_ADMIN_PASSWORD=admin123
FEATURE_PUBLISH=false
NODE_ENV=development
ENV

# 2. Install
npm install

# 3. Run
npm run dev    # nodemon (auto-restart)
# or
npm start      # plain node app.js
```

The first request after start triggers `initDB()` which creates all tables and seeds the admin user.

### Verify

```bash
curl http://localhost:5001/api/health
# {"status":"ok","message":"FMB Survey Builder API is running"}
```

---

## Running the Project

### Scripts (`package.json`)

```bash
npm start      # node app.js
npm run dev    # nodemon app.js
```

There is no separate test, lint, build, or migration script. DDL runs at boot. Uploads land in `uploads/` (created at runtime, gitignored).

### Useful one-liners

```bash
# Sanity-check syntax of a route file (no test framework configured)
node -c routes/surveys.js

# Manual ad-hoc DB query
psql "$DATABASE_URL" -c 'select count(*) from surveys'
```

---

## Testing

No tests are committed. The project is a clean slate for adding **Jest + Supertest** for HTTP integration tests:

- Add `"test": "jest"` to `package.json`.
- Place tests in `tests/` or alongside source files (`routes/surveys.test.js`).
- Use a separate database via `TEST_DATABASE_URL` to avoid polluting development data.

---

## Deployment

### Vercel serverless (default in this repo)

`vercel.json`:

```json
{
  "version": 2,
  "rewrites": [{ "source": "/(.*)", "destination": "/app.js" }],
  "crons": [
    { "path": "/api/keep-alive", "schedule": "0 8 * * *" }
  ]
}
```

- Every request is routed to `app.js`.
- A daily cron runs `/api/keep-alive` at 08:00 UTC, executing `SELECT NOW()` to prevent free-tier database providers (Supabase) from auto-pausing.
- `app.js` only invokes `app.listen()` when `process.env.VERCEL` is unset.

### Long-lived Node host (Render / EC2 / Fly.io)

- Run `npm start`.
- Provide every required env var.
- Bind a public hostname; the existing FE rewrite expects `https://survey-builder-be.onrender.com` — adjust on either side.

### CORS

`app.use(cors())` is currently fully open. **Restrict it before serious production use.**

---

## Security & Permissions

### Authentication
- JWT issued by `POST /api/auth/login`. The token expires after 24 hours.
- `middleware/auth.js` verifies the token and decodes `req.user`.

### Authorization

| Middleware | Checks |
|---|---|
| `requireAuth` | Token present + valid. |
| `requireAdmin` | `req.user.role === 'admin'`. |
| `requireWriteAccess` | admin **or** (state user **and** `is_active=true`). |

### Role matrix

| Action | admin | state (active) | state (inactive) |
|---|---|---|---|
| Read own-state surveys | ✓ | ✓ | ✓ |
| Read all surveys | ✓ | — | — |
| Create / update / delete survey | ✓ | ✓ | — |
| Publish survey | ✓ | ✓ | — |
| Unpublish survey | ✓ | — | — |
| User management | ✓ | — | — |
| State config | ✓ | — | — |

### Other security practices

- All SQL is parameterised (`$1`, `$2`, …) — never string-interpolated.
- Multer caps uploads at `IMPORT_MAX_FILE_SIZE_MB` (default 10 MB).
- Upload rows are capped at `IMPORT_MAX_ROWS` (default 10,000) to avoid runaway memory use.

---

## Error Handling & Logging

- Global Express error middleware in `app.js` returns:
  ```json
  { "error": "<type>", "message": "<message>", "errors": ["…"] }
  ```
- Routes wrap the handler body in `try/catch` and `console.error` failures.
- Validation responses look like:
  ```json
  {
    "error": "Validation failed",
    "validationErrors": [
      {
        "type": "question",
        "row": 5,
        "sheet": "Question Master",
        "surveyId": "MY_SURVEY",
        "questionId": "Q3.1",
        "errors": [
          { "field": "isMandatory", "message": "[Question Master B5] …", "value": "Yes", "row": 5, "column": "B", "cell": "B5" }
        ]
      }
    ]
  }
  ```
- Logging is `console.log` / `console.error` only — no structured logger today.

---

## Known Constraints

- **No `.env.example`** is committed — populate `.env` manually.
- **No tests** at all.
- **CORS is wide open** in production.
- **`csv-parse` and `multer`** are pinned to older majors that may need bumping.
- **No structured logging or APM** (`console.*` only).
- **DDL on boot** instead of a migration tool — fine for a small schema, but rollbacks are manual.
- **The historical `_validateChildParentType` rule was removed** because of false positives caused by whitespace/casing differences in `questionType` cells. If you re-introduce a similar check, normalise `questionType` first.
- **Long-running uploads on Vercel serverless** can exceed function execution limits for very large XLSX files. The frontend bumps its Axios timeout to 5 minutes; the platform's own limit still applies.
- **`access_sheet_latest_dump.file_bytes`** stores files as `BYTEA` — large files inflate row size. Consider object storage if files commonly exceed a few MB.

---

## Future Improvements

- Replace inline DDL in `data/db.js` with a real migration tool (`node-pg-migrate`, `knex`, Prisma).
- Add **Jest + Supertest** integration tests.
- Move SQL helpers in `data/store.js` toward a small repository pattern (one module per table) as the codebase grows.
- Tighten CORS to a configurable allow-list.
- Replace `console.*` with a structured logger (`pino` or `winston`).
- Add request rate limiting on `/api/auth/login` and `/api/import*`.
- Stream XLSX export instead of buffering the entire workbook in memory.
- Move large `access_sheet_latest_dump` file blobs to object storage (S3, Supabase storage).
- Issue refresh tokens / move JWT into `httpOnly` cookies to remove `localStorage` exposure on the FE.

---

## Contribution Guidelines

> No `CONTRIBUTING.md` is committed; this section is inferred from project conventions.

### Branching
- Features: `feature/<short-description>`
- Fixes: `fix/<short-description>`

### Commits
- Imperative present tense (`Add /api/import/validate-dump`).
- Avoid amending commits that have already been pushed.

### When adding a new route

1. Create `routes/myFeature.js` exporting an Express `Router`.
2. Apply `requireAuth` (and `requireAdmin` / `requireWriteAccess` as appropriate).
3. Add SQL helpers to `data/store.js`. **Never embed SQL in route files.**
4. Mount in `app.js`:
   ```js
   const myFeatureRouter = require('./routes/myFeature');
   app.use('/api/my-feature', requireAuth, myFeatureRouter);
   ```
5. If the feature needs validation, extend `validation/validationEngine.js` and `schemas/validationRules.js`.
6. Update this README's [API Documentation](#api-documentation) table.

### Code style

- camelCase variables/functions; SCREAMING_SNAKE_CASE constants.
- snake_case database columns.
- Prefer no comments — code should be self-documenting. Comment only when the *why* is non-obvious.
- Keep route handlers thin: parse → validate → call store → respond.

---

## Quick Reference

```bash
# Dev
npm run dev

# Prod
npm start

# Health
curl http://localhost:5001/api/health
curl http://localhost:5001/api/keep-alive

# DB sanity check
psql "$DATABASE_URL" -c '\dt'
```
