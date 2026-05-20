# Survey Builder Backend (`fmb-survey-builder-server`)

Node 18 + Express REST API for the FMB Survey Builder. PostgreSQL persistence (JSONB-first), JWT auth, RBAC, 15-min edit locks, Excel/CSV import-export, validation engine, translation proxy.

> Project-wide overview & glossary: [root README](../README.md).
> Companion service: [`../Survey-builder-FE`](../Survey-builder-FE).

---

## 1. Stack

| Concern | Library | Version | Notes |
|---|---|---|---|
| Runtime | Node.js | 18+ (16 min) | |
| Web | `express` | 4.18 | Single app, all routes under `/api` |
| DB driver | `pg` | 8 | Pool: `max=10` local / `max=2` on Vercel |
| Auth | `jsonwebtoken` | 9 | 24 h expiry |
| Hashing | `bcryptjs` | 3 | 10 rounds |
| Uploads | `multer` | 1.4.5-lts | Disk to `uploads/`, default 10 MB cap |
| XLSX | `exceljs` | 4.4 | Workbook buffered in memory (see Limits) |
| CSV | `csv-parse` | 5.5 | |
| Compression | `compression` | 1.8 | gzip all responses |
| Config | `dotenv` | 17 | `.env` at project root |
| Dev | `nodemon` | 3 | `npm run dev` |

**Not configured:** ESLint, Prettier, Jest/Mocha, structured logger, migration tool.

---

## 2. Feature → Limit Map

| # | Feature | Endpoint(s) | Limit / Caveat |
|---|---|---|---|
| 1 | **JWT login** | `POST /api/auth/login` | 24 h tokens. No refresh. No password reset endpoint. |
| 2 | **RBAC** | `requireAuth` / `requireAdmin` / `requireWriteAccess` | Three middleware tiers. No per-resource ACLs. |
| 3 | **State-scoped reads** | All survey/question reads | Non-admin: filtered by `req.user.stateCode`. Admin: no filter. |
| 4 | **Survey CRUD** | `GET/POST/PUT/DELETE /api/surveys/:id?` | `survey_id` regex `^[A-Za-z0-9_]+$`. Cascade-deletes questions + locks. |
| 5 | **Question CRUD** | `… /surveys/:id/questions/:qId?` | Composite PK `(survey_id, question_id)`. 12 types. |
| 6 | **Subtree duplication** | `POST /api/surveys/:id/questions/:qId/duplicate` | Remaps `OptionXChildren` and `sourceQuestion`. Collisions → `400` with list. |
| 7 | **Survey duplicate** | `POST /api/surveys/:id/duplicate` | Clones survey row + (optional) all questions. |
| 8 | **Concurrency locks** | `POST/GET/DELETE /api/surveys/:id/lock` | 15-min TTL. `PUT /surveys/:id` returns `409 { lockOwner }` on conflict. Lazy cleanup. |
| 9 | **Publish / Unpublish** | `POST /api/surveys/:id/publish`, `…/unpublish` | Gated by `FEATURE_PUBLISH=true`. Unpublish is **admin-only**. Question mutations blocked while `PUBLISHED`. |
| 10 | **Import — preview** | `POST /api/import/preview` | Returns `{surveys, questions, validationErrors}`. Persists nothing. |
| 11 | **Import — commit** | `POST /api/import?surveyIds=A,B&overwrite=true` | Default caps: 10 MB / 10 000 rows. Batched upserts (25 at a time). |
| 12 | **Dumpsheet Validator** | `POST /api/import/validate-dump` | Errors only for rows where `Mode ∈ {New Data, Correction}`. Persists nothing. |
| 13 | **Excel Export** | `GET /api/export/:surveyId` | Buffers full workbook in memory (no streaming). |
| 14 | **Designation hierarchy** | `GET/POST/PATCH/DELETE /api/designations`, `/export`, `/seed-defaults` | UNIQUE `(state_code, medium_in_english, hierarchy_level)`. |
| 15 | **Access Sheet dump** | `POST /api/access-sheet/dump`, `GET /latest`, `GET /latest/download`, `POST /validate` | One row per state. File stored as `BYTEA` — heavy at scale. |
| 16 | **Translation proxy** | `POST /api/translate` | Default backend `libretranslate.de`. 10 s timeout. Optional API key. |
| 17 | **Validation engine** | `GET /api/validation-schema`, `POST /api/validate-upload` | Single source of truth in `validation/validationEngine.js`. |
| 18 | **Keep-alive cron** | `GET /api/keep-alive` | Daily `0 8 * * *` from `vercel.json`. Defends free-tier DB auto-pause. |
| 19 | **Health check** | `GET /api/health` | Public. |
| 20 | **Lazy DB init** | n/a (middleware) | First request triggers `initDB()`; failures return `503`. |

---

## 3. File Tree

```
Survey-builder-BE/
├── app.js                            # Express bootstrap; CORS+gzip+bodyParser; lazy initDB middleware; route mount; error handler
├── package.json                      # scripts: start, dev
├── vercel.json                       # serverless: rewrites /(.*)/ → app.js; cron /api/keep-alive @ 0 8 * * *
│
├── data/
│   ├── db.js                         # pg.Pool, SSL auto-detect, initDB() DDL, admin seed
│   └── store.js                      # ALL SQL — surveys/questions/locks/users/designations/state_config/access_sheet helpers
│
├── middleware/
│   └── auth.js                       # requireAuth (JWT verify + attach req.user), requireAdmin, requireWriteAccess
│
├── routes/
│   ├── auth.js                       # POST /login
│   ├── surveys.js                    # surveys + questions CRUD + lock + duplicate + publish/unpublish (16 endpoints)
│   ├── admin.js                      # users + state-config CRUD
│   ├── designations.js               # GET, GET /export, POST /seed-defaults, POST, PATCH /:id, DELETE /:id
│   ├── accessSheet.js                # POST /dump, GET /latest, GET /latest/download, POST /validate
│   ├── import.js                     # POST / (commit), POST /preview, POST /validate-dump  (multer middleware)
│   ├── export.js                     # GET /:surveyId → XLSX stream
│   ├── validateUpload.js             # POST / — standalone upload validator
│   ├── validationSchema.js           # GET / — returns validation rules JSON (drives FE)
│   └── translate.js                  # POST / — LibreTranslate proxy
│
├── services/
│   ├── validator.js                  # Thin facade over validationEngine
│   ├── excelGenerator.js             # ExcelJS workbook builder (one row per language via `translations`)
│   └── accessSheetUtils.js           # Access-sheet XLSX parsing/validation helpers
│
├── schemas/
│   └── validationRules.js            # Question-type enum, mode enum, regex constants
│
├── validation/
│   └── validationEngine.js           # Canonical rules (CRUD + 3 import endpoints share this)
│
└── uploads/                          # Multer disk staging (gitignored, runtime only)
```

---

## 4. Database Schema

DDL is in [`data/db.js`](./data/db.js) (idempotent, runs on first request). All SQL is parameterised and lives in [`data/store.js`](./data/store.js).

### 4.1 Tables

```sql
-- surveys
survey_id   TEXT PRIMARY KEY
state_code  TEXT                 -- nullable; null = admin-owned / unscoped
data        JSONB NOT NULL       -- full survey doc
publish     JSONB NOT NULL DEFAULT '{"status":"DRAFT"}'
created_at  TIMESTAMPTZ DEFAULT NOW()
updated_at  TIMESTAMPTZ DEFAULT NOW()

-- questions
survey_id   TEXT NOT NULL REFERENCES surveys(survey_id) ON DELETE CASCADE
question_id TEXT NOT NULL                  -- ^Q\d+(\.\d+)*$
data        JSONB NOT NULL
created_at  TIMESTAMPTZ DEFAULT NOW()
updated_at  TIMESTAMPTZ DEFAULT NOW()
PRIMARY KEY (survey_id, question_id)

-- users
id          SERIAL PRIMARY KEY
username    TEXT UNIQUE NOT NULL
password    TEXT NOT NULL                  -- bcrypt hash
role        TEXT NOT NULL DEFAULT 'state'  -- 'admin' | 'state'
state_code  TEXT                            -- null for admins
is_active   BOOLEAN NOT NULL DEFAULT TRUE
created_at  TIMESTAMPTZ DEFAULT NOW()
updated_at  TIMESTAMPTZ DEFAULT NOW()

-- survey_locks
survey_id   TEXT PRIMARY KEY REFERENCES surveys(survey_id) ON DELETE CASCADE
locked_by   INTEGER NOT NULL REFERENCES users(id)
locked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
expires_at  TIMESTAMPTZ NOT NULL            -- locked_at + 15 min

-- designation_hierarchy
id                 SERIAL PRIMARY KEY
state_code         TEXT NOT NULL
designation_id     INT                       -- nullable (relaxed via migration)
hierarchy_level    INT  NOT NULL
designation_name   TEXT NOT NULL
medium             TEXT NOT NULL             -- native language
medium_in_english  TEXT NOT NULL
is_active          BOOLEAN DEFAULT TRUE
created_by         TEXT
updated_by         TEXT
created_at         TIMESTAMPTZ DEFAULT NOW()
updated_at         TIMESTAMPTZ DEFAULT NOW()
UNIQUE (state_code, medium_in_english, hierarchy_level)

-- state_config
state_code           TEXT PRIMARY KEY
state_name           TEXT NOT NULL
available_languages  TEXT NOT NULL DEFAULT '' -- CSV string, e.g. "English,Hindi"

-- access_sheet_latest_dump
state_code  TEXT PRIMARY KEY
dumped_at   TIMESTAMPTZ DEFAULT NOW()
dumped_by   TEXT NOT NULL
file_name   TEXT NOT NULL
mime_type   TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
file_bytes  BYTEA NOT NULL                   -- inline XLSX blob (one per state)
summary     JSONB NOT NULL DEFAULT '{}'
```

### 4.2 Indexes

```
idx_surveys_state_code   ON surveys(state_code)
idx_questions_survey_id  ON questions(survey_id)
idx_designation_state    ON designation_hierarchy(state_code)
idx_users_username       ON users(username)
```

### 4.3 Inline migrations (run every boot)

- `designation_hierarchy.designation_id` made NULLable.
- Old constraint `designation_hierarchy_state_code_designation_id_key` dropped if present.
- New columns added to existing `surveys`: `state_code`, `publish`, `created_at`, `updated_at`.

### 4.4 Admin seed

On boot, if `SEED_ADMIN_USER` and `SEED_ADMIN_PASSWORD` are set AND the user doesn't exist, a bcrypt-hashed admin is inserted.

### 4.5 `surveys.data` / `questions.data` JSONB shape

See the **root README §4** for the JSONB shape contract — single source of truth.

---

## 5. API Reference

> All paths under `/api`. Protected routes require `Authorization: Bearer <jwt>`.

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ status: "ok" }` |
| `GET` | `/keep-alive` | `SELECT NOW()` ping — cron target |
| `POST` | `/auth/login` | `{username, password}` → `{token, user}` |

### Surveys & Questions (`requireAuth` + write gates)

| Method | Path | Auth gate |
|---|---|---|
| `GET` | `/surveys` | requireAuth (state-scoped) |
| `GET` | `/surveys/:id` | requireAuth (state-scoped) |
| `POST` | `/surveys` | requireWriteAccess |
| `PUT` | `/surveys/:id` | requireWriteAccess + lock check |
| `DELETE` | `/surveys/:id` | requireWriteAccess |
| `POST` | `/surveys/:id/duplicate` | requireWriteAccess |
| `POST` | `/surveys/:id/lock` | requireWriteAccess |
| `GET` | `/surveys/:id/lock` | requireAuth |
| `DELETE` | `/surveys/:id/lock` | requireAuth (only owner) |
| `POST` | `/surveys/:id/publish` | requireWriteAccess + `FEATURE_PUBLISH` |
| `POST` | `/surveys/:id/unpublish` | **requireAdmin** |
| `GET` | `/surveys/:id/questions` | requireAuth |
| `POST` | `/surveys/:id/questions` | requireWriteAccess |
| `PUT` | `/surveys/:id/questions/:qId` | requireWriteAccess |
| `DELETE` | `/surveys/:id/questions/:qId` | requireWriteAccess |
| `POST` | `/surveys/:sId/questions/:qId/duplicate` | requireWriteAccess (subtree clone) |

### Admin (`requireAdmin`)

| Method | Path |
|---|---|
| `GET` / `POST` / `PATCH` | `/admin/users`, `/admin/users/:id` |
| `GET` / `POST` / `PATCH` / `DELETE` | `/admin/state-config`, `/admin/state-config/:state_code` |

### Import / Export

| Method | Path | Description |
|---|---|---|
| `POST` | `/import/preview` | Validate, return parsed data. No persistence. |
| `POST` | `/import?overwrite=…&surveyIds=…` | Validate + upsert. |
| `POST` | `/import/validate-dump` | Errors only for `Mode∈{New Data,Correction}`. No persistence. |
| `GET` | `/export/:surveyId` | XLSX stream. |

### Designations

| Method | Path |
|---|---|
| `GET` | `/designations?stateCode=&activeOnly=true` |
| `GET` | `/designations/export` |
| `POST` | `/designations/seed-defaults` |
| `POST` | `/designations` (write) |
| `PATCH` | `/designations/:id` (write) |
| `DELETE` | `/designations/:id` (write) |

### Access Sheet

| Method | Path |
|---|---|
| `POST` | `/access-sheet/dump` |
| `GET` | `/access-sheet/latest?stateCode=XX` |
| `GET` | `/access-sheet/latest/download?stateCode=XX` |
| `POST` | `/access-sheet/validate` |

### Utility

| Method | Path |
|---|---|
| `POST` | `/translate` (LibreTranslate proxy) |
| `POST` | `/validate-upload` |
| `GET` | `/validation-schema` |

### Error envelope (validation)

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
        { "field": "isMandatory", "message": "[Question Master B5] …",
          "value": "Yes", "row": 5, "column": "B", "cell": "B5" }
      ]
    }
  ]
}
```

---

## 6. Validation Engine — Key Rules

(Full source: [`validation/validationEngine.js`](./validation/validationEngine.js))

- **Required survey fields:** `surveyId`, `surveyName`, `surveyDescription`, `availableMediums`.
- **Required question fields:** `questionId`, `surveyId`, `medium`, `questionType`, `questionDescription`.
- **Question ID:** `^Q\d+(\.\d+)*$`.
- **MCSS options:** 1–20, each ≤ 100 chars.
- **Tabular `tableHeaderValue`:** exactly two comma-separated headers.
- **Tabular `tableQuestionValue`:** optional; if present, `^[A-Za-z]:.*(\n[A-Za-z]:.*)*$` (literal `\n` normalised before testing).
- **Child mandatory:** child can be `isMandatory='Yes'` only if its parent is too (`_validateChildMandatory`).
- **Child mappings:** a child ID may be claimed by exactly one option/parent (`_validateChildMappings`).
- **Removed:** `_validateChildParentType` (false positives from whitespace/casing in `questionType`).

### Import-time normalisations

- `isMandatory` empty → `'No'`.
- `mode` case-insensitive collapse (`new data`/`NEW DATA` → `'New Data'`).
- `tableQuestionValue`: literal `\n` → real newline.
- `textInputType`: common typos (`numaric`) → canonical.

---

## 7. Environment Variables

See **root README §5** for the full table. Required: `DATABASE_URL`, `JWT_SECRET`. Optional but useful: `SEED_ADMIN_USER`/`SEED_ADMIN_PASSWORD`, `FEATURE_PUBLISH`, `IMPORT_MAX_*`, `TRANSLATE_*`.

No `.env.example` ships — create manually.

---

## 8. Local Setup

```bash
cd Survey-builder-BE
# Create .env (no template shipped). Minimum:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fmb_survey_builder
#   JWT_SECRET=replace-with-a-long-random-string
#   SEED_ADMIN_USER=admin
#   SEED_ADMIN_PASSWORD=admin123
npm install
npm run dev        # nodemon
# Sanity:
curl http://localhost:5001/api/health
```

First request triggers `initDB()` → tables + admin seed. No separate migration step.

---

## 9. Deployment

### Vercel serverless (default)

```json
{ "version": 2,
  "rewrites": [{ "source": "/(.*)", "destination": "/app.js" }],
  "crons":    [{ "path": "/api/keep-alive", "schedule": "0 8 * * *" }] }
```

- Every request → `app.js`.
- `app.listen` is **skipped** when `process.env.VERCEL` is set.
- Pool downgrades to `max=2`, idle `10 s` in serverless mode (see [`data/db.js:13-20`](./data/db.js#L13-L20)).

### Long-lived Node (Render/EC2/Fly)

- `npm start` runs `node app.js`.
- Set all required env vars.
- Existing FE rewrite points at `https://survey-builder-be.onrender.com` — match or change.

### CORS

`app.use(cors())` is fully open today. **Lock down before serious production.**

---

## 10. Limits & Known Constraints

- **No tests.** No framework configured.
- **No structured logging or APM** — `console.*` only.
- **CORS open** (no allow-list).
- **No rate limiting.** `/auth/login` and `/import` are exposed.
- **No `.env.example`.**
- **No migration tool** — DDL on boot; rollbacks are manual.
- **Excel export buffers** the whole workbook (no `exceljs` streaming write).
- **`access_sheet_latest_dump.file_bytes`** stores BYTEA — large files inflate row size; move to object storage at scale.
- **Vercel function timeout** can be exceeded by very large XLSX imports. FE bumps Axios upload timeout to 5 minutes; platform limit still applies.
- **`csv-parse` / `multer`** pinned to older majors.
- **JWT in `localStorage` (FE)** — XSS-readable. No refresh tokens, no httpOnly cookie path.
- **`questionType=Voice Response`** is in the enum but no FE renderer (Inferred).

---

## 11. Future Improvements

- Migrate DDL to `node-pg-migrate` / `knex` / Prisma.
- Add Jest + Supertest integration tests; use `TEST_DATABASE_URL`.
- Tighten CORS to an allow-list (`CORS_ORIGINS` env).
- Replace `console.*` with `pino` (structured JSON logs).
- Add `express-rate-limit` on `/auth/login` and `/import/*`.
- Stream XLSX export instead of buffering.
- Move access-sheet blobs to S3 / Supabase Storage.
- Issue refresh tokens; move JWT to `httpOnly` cookies.
- Split `data/store.js` into per-table repositories.
- Add audit-log table (see `../AUDIT_LOGGING.md`).

---

## 12. Conventions

- **Layering:** `route → middleware → service/validator → store → pg`. Never embed SQL in routes.
- **SQL safety:** parameterised only (`$1, $2 …`).
- **Naming:** camelCase JS, SCREAMING_SNAKE constants, snake_case DB columns.
- **Async/error:** all handlers `async` + `try/catch`; rethrow to global Express handler when appropriate.
- **No comments by default** — code should self-document. Comment only the *why* of non-obvious logic.

---

## 13. Quick Reference

```bash
npm run dev                              # nodemon dev server
npm start                                # node app.js
curl http://localhost:5001/api/health
curl http://localhost:5001/api/keep-alive
node -c routes/surveys.js                # syntax check (no tests configured)
psql "$DATABASE_URL" -c '\dt'            # list tables
```
