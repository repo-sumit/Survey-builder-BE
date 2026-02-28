# Survey Builder Backend 

Node.js + Express backend for the Survey Builder platform. This service owns:
- **Authentication & RBAC** (admin vs state users)
- **Survey + Question persistence** (PostgreSQL JSONB)
- **Concurrency control** (survey edit locks)
- **Import / Export** utilities (Excel/CSV)
- **Validation pipeline** for survey payloads and uploads
- **Supporting masters** (designation hierarchy, access-sheet dump)

> Frontend lives separately: `repo-sumit/Survey-builder-FE`  
> Backend repo: `repo-sumit/Survey-builder-BE`

---

## 1) Tech Stack

### Runtime & Framework
- **Node.js** (Express)
- **Middleware**: `cors`, `body-parser`, `dotenv`

### Data & Storage
- **PostgreSQL** via `pg`
- Survey and question payloads are stored as **JSONB** for flexibility (schema is enforced at app layer).

### Auth & Security
- **JWT** auth via `jsonwebtoken`
- **Password hashing** via `bcryptjs`

### Files / Utilities
- Upload handling: `multer`
- Spreadsheet export: `exceljs`
- CSV parsing: `csv-parse`

### Dev tooling
- `nodemon` for local hot reload

---

## 2) Repository Structure

Top-level in `server/`:

```
- .env
- .env.example
- .gitignore
- app.js
- data/
- middleware/
- package-lock.json
- package.json
- routes/
- schemas/
- scripts/
- services/
- uploads/
- validation/
```

### Key folders
- `app.js` — Express bootstrap + route mounting + production static hosting toggle
- `data/`
  - `db.js` — PostgreSQL pool + **idempotent table init** + optional admin seed
  - `store.js` — “store” abstraction backed by Postgres tables (`surveys`, `questions`)
- `routes/` — API endpoints grouped by domain (auth/admin/surveys/export/import/etc.)
- `middleware/` — `requireAuth`, `requireAdmin`, `requireWriteAccess`
- `services/` — business utilities (validators, parsing, translations, etc.)
- `schemas/`, `validation/` — validation schema assets / rules (used by validate endpoints)
- `uploads/` — local upload staging (created at runtime)

---

## 3) Local Setup

### 3.1 Prerequisites
- Node.js (recommended: **18+**)
- PostgreSQL (local or cloud)

### 3.2 Environment Variables

Create your `.env` from `.env.example`:

```bash
cd server
cp .env.example .env
```

`.env.example` (current keys):

```env
# PostgreSQL Connection
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fmb_survey_builder

# JWT Secret — change this in production!
JWT_SECRET=change-this-to-a-random-secret

# Server Port
PORT=5000

# Seed an initial admin user on first startup
SEED_ADMIN_USER=admin
SEED_ADMIN_PASSWORD=admin123

# Feature Flags
FEATURE_PUBLISH=false

# Node Environment
NODE_ENV=development
```

#### Notes
- `DATABASE_URL` supports local Postgres and cloud providers.
- Cloud DB SSL is **auto-enabled** if:
  - URL contains `supabase.com` or `neon.tech`, **or**
  - `NODE_ENV=production`

---

## 4) Install & Run

```bash
cd server
npm install
npm run dev     # nodemon app.js
# OR
npm start       # node app.js
```

Service defaults to:
- **API Base**: `http://localhost:PORT/api`
- **Health**: `GET /api/health`

---

## 5) Database Model (Auto-created on Startup)

This backend runs `initDB()` at startup (no separate migration tool required). Tables are created if they do not exist.

### Core tables
- `surveys`
  - `survey_id` (PK)
  - `state_code` (nullable; used for tenant scoping)
  - `data` (JSONB)
  - `publish` (JSONB; default `{"status":"DRAFT"}`)
- `questions`
  - composite PK `(survey_id, question_id)`
  - `data` (JSONB)
- `users`
  - `username` unique
  - `role`: `admin` | `state`
  - `state_code` optional (required for state users)
  - `is_active` (inactive users become read-only)
- `survey_locks`
  - concurrency locks with 15-minute expiry
- `designation_hierarchy`
- `access_sheet_latest_dump` (stores latest uploaded dump as BYTEA + summary JSON)

### Admin seed (optional)
If env vars exist, first startup seeds an admin user:
- `SEED_ADMIN_USER`
- `SEED_ADMIN_PASSWORD`

---

## 6) Authentication & Authorization (RBAC)

### JWT
- Login returns `{
  token,
  user: { id, username, role, stateCode, isActive }
}`
- All protected endpoints require:
  - `Authorization: Bearer <token>`

### Roles
- **admin**
  - full access to all surveys/users
  - can unpublish surveys
- **state**
  - scoped access to surveys where `survey.stateCode === user.stateCode`
  - can write **only if** `is_active=true`

### Write gating
`requireWriteAccess` blocks write requests for inactive state users:
- inactive state user: **read-only** access (403 on write)

---

## 7) API Surface Area

> All routes are mounted under `/api/*` in `app.js`.

### 7.1 Health
- `GET /api/health` → `{
  status: "ok",
  message: "FMB Survey Builder API is running"
}`

### 7.2 Auth
- `POST /api/auth/login`

Payload:
```json
{ "username": "admin", "password": "admin123" }
```

Response:
```json
{ "token": "<jwt>", "user": { "id": 1, "username": "admin", "role": "admin" } }
```

### 7.3 Surveys (Protected)
Mounted at: `/api/surveys`

Key endpoints (from `routes/surveys.js`):
- `GET /` list surveys (state-scoped for non-admin)
- `GET /:id` fetch by ID (state-scoped)
- `POST /` create (write access required)
- `PUT /:id` update (write access + lock enforcement)
- Locking & publish routes exist inside this router as well.

#### Concurrency locking (15 min)
The API enforces survey edit locking to prevent overwrite:
- lock is stored in `survey_locks`
- expired locks are cleaned automatically
- lock conflicts return **409** with lock owner information

### 7.4 Publishing (Feature-flagged)
Publish API exists but is **disabled by default**.

- Controlled by: `FEATURE_PUBLISH`
- Default in `.env.example`: `FEATURE_PUBLISH=false`

Endpoints:
- `POST /api/surveys/:id/publish`  
  - If feature disabled → returns `{ featureEnabled: false }`
  - Requires at least one question before publishing
- `POST /api/surveys/:id/unpublish` *(admin only)*

**Status stored in** `surveys.publish` JSONB:
- `DRAFT`
- `PUBLISHED` (adds `publishedAt`, `publishedBy`)

### 7.5 Admin (Protected + Admin-only)
Mounted at: `/api/admin`

User management:
- `GET /users`
- `POST /users` (create)
- `PATCH /users/:id` (toggle active / reset password / change role/stateCode)

### 7.6 Export / Import (Protected)
Mounted at:
- `/api/export`
- `/api/import`

Used for downloading / uploading survey artifacts (Excel/CSV). Implementation leverages `exceljs` and `csv-parse`.

### 7.7 Validation APIs (Protected)
Mounted at:
- `/api/validate-upload`
- `/api/validation-schema`

Used to validate uploaded files and to serve schema definitions to the frontend.

### 7.8 Translate (Protected)
Mounted at:
- `/api/translate`

Used to translate survey content (exact behavior depends on configured service logic in `routes/translate.js` / `services/`).

### 7.9 Designations + Access Sheet (Protected)
Mounted at:
- `/api/designations`
- `/api/access-sheet`

Supports designation hierarchy and the “latest access sheet dump” persistence in Postgres.

---

## 8) Active vs Inactive Functionality

### Active (shipping now)
- JWT login + RBAC
- Survey CRUD (state-scoped)
- Survey locking (conflict protection)
- Admin user management
- Import / Export utilities
- Validation routes
- Designations + Access sheet modules
- Production mode can serve `client/build` *(monorepo support)*

### Inactive / gated
- **Publish** flow is **feature-flagged** (disabled unless `FEATURE_PUBLISH=true`)

---

## 9) Connecting Frontend (Survey-builder-FE) to Backend

### Local dev (recommended)
1. Start Postgres
2. Start backend:
   ```bash
   cd server
   npm run dev
   ```
3. Configure frontend to call:
   - `http://localhost:5000/api` (default from `.env.example`)

If FE uses CRA proxy:
- set FE `proxy` to `http://localhost:5000`
- FE should call relative paths like `/api/auth/login`, `/api/surveys`

### Production
Because FE and BE are hosted separately, you typically want:
- FE `REACT_APP_API_BASE_URL=https://<your-backend-host>/api`
- Ensure backend CORS allows FE origin (`app.use(cors())` is currently permissive; tighten for production)

---

## 10) Example Requests

### Login
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

### List surveys
```bash
curl http://localhost:5000/api/surveys \
  -H "Authorization: Bearer <token>"
```

---

## 11) Operational Notes

- **Migrations**: handled at startup via `initDB()` (idempotent DDL)
- **Uploads**: stored in `server/uploads` (created if missing)
- **Error handling**: global Express error handler returns `{
  error,
  message
}`

---

## License
TODO
