# CLAUDE.md — Survey Builder Backend

This file describes the codebase structure, conventions, and development workflows for AI assistants working on this repository.

---

## Project Overview

**Survey-builder-BE** is a Node.js/Express REST API backend for managing multi-language, state-scoped surveys. Core capabilities:

- JWT authentication with role-based access control (admin / state-user)
- Survey and question CRUD with concurrency locks (15-min TTL)
- Excel/CSV import and export
- Comprehensive server-side validation engine
- Designation hierarchy management
- Access sheet dump/upload workflows
- Translation proxy (LibreTranslate)
- PostgreSQL persistence with JSONB for flexible schemas

---

## Repository Structure

```
Survey-builder-BE/
├── app.js                        # Express app entry point; mounts all routes
├── package.json                  # Scripts and dependencies
├── .env.example                  # Environment variable template
│
├── data/
│   ├── db.js                     # PostgreSQL pool, DDL init (initDB), auto SSL detection
│   └── store.js                  # Data-access layer — all SQL queries live here
│
├── middleware/
│   └── auth.js                   # requireAuth, requireAdmin, requireWriteAccess
│
├── routes/
│   ├── auth.js                   # POST /api/auth/login
│   ├── surveys.js                # Survey + question CRUD, locks, publish
│   ├── admin.js                  # User management (admin only)
│   ├── export.js                 # GET /api/export/:surveyId → Excel
│   ├── import.js                 # POST /api/import ← Excel/CSV
│   ├── validateUpload.js         # POST /api/validate-upload
│   ├── validationSchema.js       # GET /api/validation-schema
│   ├── translate.js              # POST /api/translate (LibreTranslate proxy)
│   ├── designations.js           # Designation hierarchy CRUD
│   └── accessSheet.js            # Access sheet dump/retrieve/upload
│
├── validation/
│   └── validationEngine.js       # All validation rules; called by routes and store
│
├── schemas/
│   └── validationRules.js        # Validation rule constants/enums
│
├── services/
│   ├── validator.js              # Thin facade over validationEngine
│   ├── excelGenerator.js         # Excel workbook helpers (ExcelJS)
│   └── accessSheetUtils.js       # Access sheet parsing/validation helpers
│
├── scripts/
│   └── migrate.js                # One-time migration: store.json → PostgreSQL
│
└── uploads/                      # Runtime directory for multer disk uploads (gitignored)
```

---

## Technology Stack

| Concern | Library / Tool |
|---|---|
| Web framework | Express 4.x |
| Database | PostgreSQL (`pg` pool, JSONB columns) |
| Authentication | `jsonwebtoken` (JWT, 24 h expiry) |
| Password hashing | `bcryptjs` |
| File uploads | `multer` (10 MB limit) |
| Excel read/write | `exceljs` |
| CSV parsing | `csv-parse` |
| Compression | `compression` (gzip) |
| Config | `dotenv` |
| Dev server | `nodemon` |

No test framework or linter is configured currently.

---

## Environment Variables

Copy `.env.example` to `.env` before starting the server.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `JWT_SECRET` | yes | `dev-secret-change-in-production` | Token signing key |
| `PORT` | no | `5000` | Listening port |
| `SEED_ADMIN_USER` | no | `admin` | Username for seeded admin |
| `SEED_ADMIN_PASSWORD` | no | `admin123` | Password for seeded admin |
| `FEATURE_PUBLISH` | no | `false` | Enable publish/unpublish endpoints |
| `NODE_ENV` | no | `development` | `production` enables SSL |
| `DB_SSL` | no | auto-detected | Force SSL for DB (`true`/`false`) |
| `TRANSLATE_API_URL` | no | `https://libretranslate.de/translate` | Translation backend |
| `TRANSLATE_API_KEY` | no | — | API key for translation service |
| `TRANSLATE_TIMEOUT_MS` | no | `10000` | Translation request timeout (ms) |

**SSL auto-detection:** SSL is enabled automatically when `DATABASE_URL` contains `supabase.com`, `neon.tech`, `railway.app`, `render.com`, `cockroachlabs.com`, `googleapis.com`, or `cloudsql`, or when `NODE_ENV=production`.

---

## Development Workflow

### Setup

```bash
npm install
cp .env.example .env
# Edit .env with your PostgreSQL connection string
```

### Running the server

```bash
npm run dev      # nodemon — auto-restarts on file changes
npm start        # plain node — for production
```

The server initialises the database schema automatically on startup (`initDB()`). All DDL uses `IF NOT EXISTS`, so it is safe to restart against an existing database. An admin user is seeded idempotently when `SEED_ADMIN_USER`/`SEED_ADMIN_PASSWORD` are set.

### Verify health

```bash
curl http://localhost:5000/api/health
```

### One-time data migration (store.json → PostgreSQL)

```bash
DATABASE_URL=postgresql://... node scripts/migrate.js
```

---

## Database Schema

All tables are created automatically. Key design decisions:

- **JSONB columns** (`surveys.data`, `questions.data`) store variable survey/question payloads to avoid schema migrations as the data model evolves.
- **Composite PK** on `questions(survey_id, question_id)`.
- **ON DELETE CASCADE** on foreign keys so deleting a survey removes its questions and locks.
- **Upsert pattern** (`ON CONFLICT DO UPDATE`) used for idempotent writes.
- **Parameterised queries** (`$1`, `$2`, …) everywhere — no string interpolation in SQL.

### Tables

| Table | Primary Key | Notes |
|---|---|---|
| `surveys` | `survey_id` | Includes `state_code`, `data` (JSONB), `publish` (JSONB) |
| `questions` | `(survey_id, question_id)` | `data` is JSONB |
| `users` | `id` | `role`: `admin` \| `state`; `state_code` nullable for admins |
| `survey_locks` | `survey_id` | `expires_at` = lock time + 15 min |
| `designation_hierarchy` | `id` | Scoped by `state_code` |
| `state_config` | `state_code` | Stores `state_name`, `available_languages` |
| `access_sheet_latest_dump` | `state_code` | Stores file as `BYTEA`, summary as JSONB |

### Performance indexes

```
idx_surveys_state_code       surveys(state_code)
idx_questions_survey_id      questions(survey_id)
idx_designation_state        designation_hierarchy(state_code)
idx_users_username           users(username)
```

---

## Authentication & Authorization

### JWT token

Obtained via `POST /api/auth/login`. Send on all protected requests:

```
Authorization: Bearer <token>
```

Token payload:
```json
{
  "id": 1,
  "username": "string",
  "role": "admin | state",
  "stateCode": "string | null",
  "isActive": true
}
```

### Middleware chain

```
requireAuth           →  validates JWT, attaches req.user
requireAdmin          →  role === 'admin' or 403
requireWriteAccess    →  admin OR (state + isActive) or 403
```

### Role matrix

| Action | admin | state (active) | state (inactive) |
|---|---|---|---|
| Read own-state surveys | ✓ | ✓ | ✓ |
| Read all surveys | ✓ | — | — |
| Create / update / delete survey | ✓ | ✓ | — |
| Publish / unpublish survey | ✓ | ✓ (publish only) | — |
| User management | ✓ | — | — |
| Designation CRUD | ✓ | read only | read only |

---

## API Endpoints

### Public

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/auth/login` | Login → JWT |

### Surveys (`requireAuth`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/surveys` | State-scoped for non-admin |
| GET | `/api/surveys/:id` | State-scoped |
| POST | `/api/surveys` | `requireWriteAccess` |
| PUT | `/api/surveys/:id` | `requireWriteAccess`, lock enforced |
| DELETE | `/api/surveys/:id` | `requireWriteAccess` |
| POST | `/api/surveys/:id/lock` | Acquire edit lock |
| POST | `/api/surveys/:id/release-lock` | Release lock |
| POST | `/api/surveys/:id/publish` | `FEATURE_PUBLISH=true` required |
| POST | `/api/surveys/:id/unpublish` | Admin only |
| POST | `/api/surveys/:id/questions` | `requireWriteAccess` |
| PUT | `/api/surveys/:id/questions/:qId` | `requireWriteAccess` |
| DELETE | `/api/surveys/:id/questions/:qId` | `requireWriteAccess` |

### Admin (`requireAdmin`)

| Method | Path |
|---|---|
| GET | `/api/admin/users` |
| POST | `/api/admin/users` |
| PATCH | `/api/admin/users/:id` |

### Other protected endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/export/:surveyId` | Export survey → Excel |
| POST | `/api/import` | Import surveys/questions ← Excel/CSV |
| POST | `/api/validate-upload` | Validate upload file |
| GET | `/api/validation-schema` | Validation rules schema |
| POST | `/api/translate` | Translation proxy |
| GET | `/api/designations` | List designations |
| GET | `/api/designations/export` | Export designations → Excel |
| POST | `/api/designations` | Create (admin only) |
| PUT | `/api/designations/:id` | Update (admin only) |
| DELETE | `/api/designations/:id` | Delete (admin only) |
| POST | `/api/access-sheet/dump` | Generate/update dump |
| GET | `/api/access-sheet/latest` | Download latest dump |
| POST | `/api/access-sheet/upload` | Upload + validate |

---

## Key Code Conventions

### Layered architecture

```
Route handler  →  store.js (SQL)  →  PostgreSQL
                ↗
middleware (auth)
```

Keep SQL in `data/store.js`. Routes call store functions; they do not embed SQL.

### Async / error handling

All route handlers use async/await. Unhandled rejections bubble to the global Express error handler in `app.js` which responds `{ error, message }`. Always `return next(err)` for async errors inside route handlers or wrap in try/catch.

### Naming

- JavaScript: `camelCase` for variables/functions, `SCREAMING_SNAKE_CASE` for constants.
- Database columns: `snake_case`.
- Route files: plural nouns (e.g., `surveys.js`, `users.js`).

### State-scoping pattern

```js
const stateCode = req.user.role !== 'admin' ? req.user.stateCode : null;
const results = await listSurveys(stateCode); // null = no filter
```

Always apply this pattern for data reads. Store functions accept `null` to mean "all states" (admin path).

### SQL safety

Never interpolate user input into SQL strings. Use parameterised queries:

```js
// Good
await pool.query('SELECT * FROM surveys WHERE survey_id = $1', [id]);

// Bad — never do this
await pool.query(`SELECT * FROM surveys WHERE survey_id = ${id}`);
```

### File uploads

Multer is configured per-route. The `uploads/` directory is runtime-only and gitignored. Accepted MIME types: `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-excel`.

---

## Validation Engine

`validation/validationEngine.js` defines rules for survey master and question master data. Key behaviours:

- **Question types supported:** Multiple Choice (single/multi select), Tabular variants, Text Response, Media uploads, Likert, Calendar, Dropdown — 12 total.
- **Option count:** typically 2–20 per question.
- **Parent-child IDs:** child questions use `Q1.1` format.
- **Error format returned to clients:** `{ errors: ["message1", "message2"] }`

When adding or modifying question types, update both `validationEngine.js` and `schemas/validationRules.js` together.

---

## Feature Flags

| Flag | Default | What it gates |
|---|---|---|
| `FEATURE_PUBLISH` | `false` | `POST /api/surveys/:id/publish` and `POST /api/surveys/:id/unpublish` endpoints |

Check the flag in route handlers as:
```js
if (process.env.FEATURE_PUBLISH !== 'true') {
  return res.status(404).json({ error: 'Feature not enabled' });
}
```

---

## Testing

No test framework is currently configured. When adding tests:

- Use **Jest** or **Mocha** + **Supertest** for HTTP integration tests.
- Add `"test": "jest"` (or equivalent) to `package.json`.
- Test files should live alongside source files or in a top-level `tests/` directory.
- Use a separate test database (`TEST_DATABASE_URL`) to avoid polluting development data.

---

## Common Pitfalls

1. **Forgetting state-scope on reads** — non-admin users must only see their own state's data. Always pass `req.user.stateCode` (or `null` for admins) to store functions.
2. **Skipping lock check on PUT** — survey updates must check `survey_locks` before writing. The check is in `store.js`; do not bypass it.
3. **Raw SQL interpolation** — always use `$N` placeholders.
4. **CORS** — currently `cors()` is permissive (all origins). For production, restrict to the frontend's origin via the `origin` option.
5. **SSL in production** — if deploying to a cloud provider not in the auto-detect list, set `DB_SSL=true` explicitly.
6. **Publishing without flag** — `FEATURE_PUBLISH` defaults to `false`. Enable it intentionally.

---

## Adding a New Route

1. Create `routes/myFeature.js` with an Express `Router`.
2. Apply `requireAuth` (and optionally `requireAdmin` / `requireWriteAccess`) as needed.
3. Add SQL helpers to `data/store.js`.
4. Mount the router in `app.js`:
   ```js
   const myFeatureRouter = require('./routes/myFeature');
   app.use('/api/my-feature', myFeatureRouter);
   ```
5. If the feature needs validation, add rules in `validation/validationEngine.js` and constants in `schemas/validationRules.js`.

---

## Deployment Notes

- **Start command:** `npm start` (runs `node app.js`).
- **Database:** PostgreSQL 13+. The app auto-creates all tables on first boot.
- **Secrets:** Provide `DATABASE_URL` and `JWT_SECRET` via environment variables or a secrets manager — never commit them.
- **Port:** Defaults to `5000`; set `PORT` to match your platform's expected port.
- **Compression:** `compression` middleware is active; no additional proxy-level compression needed.
- **Logging:** Currently uses `console.log`/`console.error`. For production, integrate a structured logger (e.g., `pino`) before enabling high-traffic load.
