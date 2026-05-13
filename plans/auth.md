# Auth & Permissions System

## Goal

Replace the simple passphrase-based login with a proper user/permissions system supporting:
- **Owner**: First user to set up the system, full admin control
- **Admins**: Can manage printers, view all jobs, manage users
- **Guests**: Can upload models, slice, view their own team's files

Guests belong to groups/teams. Everyone in a group can see each other's files (models, slices, jobs).

## Environment / Context

- **Project**: FarmSlicer — Rust (axum + tokio) backend, React + TypeScript frontend, SQLite DB
- **Key files**:
  - `src/server.rs` — HTTP router, auth middleware, all API handlers
  - `src/db.rs` — SQLite persistence (printers, jobs, slices) with WAL mode, schema migrations
  - `src/main.rs` — Entry point, wires up AppState
  - `web/src/main.tsx` — Auth state machine (loading → login → authenticated), wraps entire app
  - `web/src/pages/Login.tsx` — Current login page (single passphrase field)
  - `web/src/components/Layout.tsx` — Sidebar layout with nav links
- **Current auth implementation** (to be replaced):
  - Single `ADMIN_PASSPHRASE` env var. If set, auth is enabled; if empty, auth is disabled.
  - On startup, `AppState::new()` generates a random UUID `session_token` if passphrase is set.
  - Login: `POST /api/auth/login` with `{passphrase}` body. On match, sets `fs_session` cookie (HttpOnly, SameSite=Strict, 7-day max-age) containing the session token.
  - Auth middleware: checks `fs_session` cookie against the single in-memory token. Returns 401 if mismatch.
  - Router is split: public routes (health, auth endpoints) vs protected routes (everything else behind middleware).
  - Frontend checks `GET /api/auth/status` → `{auth_required, authenticated}` on mount. Shows Login page or app accordingly.
- **Deploy**: systemd service on `buildhost` (Ubuntu), `ADMIN_PASSPHRASE` passed via `Environment=` in unit file. Managed by `.claude/skills/deploy/deploy.sh`.
- **DB migration pattern**: In `db.rs`, migrations iterate over column names and ALTER TABLE ADD COLUMN if not present (checked via PRAGMA table_info).

## Design

### User Model

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,  -- uuid
  username      TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL,     -- 'owner', 'admin', 'guest'
  team          TEXT,              -- NULL for owner/admin, required for guests
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login    TEXT
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,  -- uuid
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

### Roles & Permissions

| Action | Owner | Admin | Guest |
|--------|-------|-------|-------|
| Manage printers | Yes | Yes | No |
| Manage users | Yes | Yes (can't modify owner) | No |
| View all jobs/slices | Yes | Yes | No |
| Upload & slice models | Yes | Yes | Yes |
| View own team's files | Yes | Yes | Yes (team only) |
| System settings | Yes | No | No |
| Initial setup | Yes (first user) | No | No |

### First-Run Setup Flow

1. New endpoint: `GET /api/auth/status` returns `{setup_required: true}` when no users exist
2. Frontend detects this and shows a "Setup" page instead of login
3. `POST /api/auth/setup` with `{username, password}` creates the first user as `owner`
4. After setup, redirect to login

### Guest Teams

- Guests belong to a team/group. The team determines file visibility scope.
- All models, jobs, and slices need a `user_id` column added
- Guest queries filter by team: "show files from all users in my team"
- Admins/owner see everything regardless of team
- Team names: either freeform strings or managed by admins (TBD — see open questions)

### Session Management

- Replace the single in-memory token with per-user sessions in the DB
- Each login creates a new session row with an expiry (7 days)
- Auth middleware looks up `fs_session` cookie in the sessions table, joins to users to get role
- Expired sessions cleaned up periodically or on access
- Logout deletes the session row

### API Changes

Current endpoints that need modification:
- `GET /api/auth/status` — add `setup_required` field, return user info when authenticated
- `POST /api/auth/login` — accept `{username, password}` instead of `{passphrase}`
- `POST /api/auth/logout` — delete session from DB
- Auth middleware — look up session in DB, attach user info to request extensions

New endpoints:
- `POST /api/auth/setup` — first-run owner creation
- `GET /api/users` — list users (admin only)
- `POST /api/users` — create user (admin only)
- `DELETE /api/users/{id}` — delete user (admin only, can't delete owner)
- `PUT /api/users/{id}` — update user role/team (admin only)

Modified endpoints (add user_id scoping):
- `POST /api/jobs` — tag with user_id
- `GET /api/jobs` — filter by team for guests
- `GET /api/slices` — filter by team for guests

### Password Hashing

Need a Rust crate for secure password hashing. Options:
- `argon2` crate — modern, recommended
- `bcrypt` crate — simpler, widely used
- Recommendation: argon2 (it's the current best practice)

### Migration from Current Auth

Options:
1. If `ADMIN_PASSPHRASE` is set and no users exist, auto-create an owner account (username "admin", password = passphrase value)
2. Drop ADMIN_PASSPHRASE entirely, always require user setup
3. Support both modes during transition

Decision needed from user.

## Decisions Already Made

- (none yet — this needs discussion before implementation)

## Open Questions for User

1. **Guest account creation**: Do admins create guest accounts? Or is there a self-registration flow where guests pick a team name? Or both?
2. **Team management**: Are teams just freeform strings (guest types "Team Alpha" at registration), or should there be a managed list of teams that admins create?
3. **Password requirements**: Any minimum complexity? Or keep it simple (just non-empty)?
4. **Migration**: Should existing ADMIN_PASSPHRASE deployments auto-migrate to an owner account, or require fresh setup?
5. **Scope**: Should we tackle this all at once, or start with just owner+admin (no guest/team system) and add guest mode later?

## Things Not to Do

- Don't use JWT — cookie sessions with server-side storage are simpler and more secure for this use case
- Don't add OAuth/SSO — this is a small self-hosted service, local accounts are fine
- Don't over-engineer team management — start simple, add complexity later

## Progress

- [ ] Design approved by user
- [ ] DB schema: users + sessions tables
- [ ] Backend: Password hashing (add argon2 dep)
- [ ] Backend: User CRUD endpoints
- [ ] Backend: Session-based auth replacing single token
- [ ] Backend: First-run setup detection + setup endpoint
- [ ] Backend: Role-based middleware (admin vs guest)
- [ ] Backend: Team-scoped queries for jobs/slices/models (add user_id to jobs/slices)
- [ ] Frontend: Setup page (first-run)
- [ ] Frontend: Login page (update for username + password)
- [ ] Frontend: Admin panel (Users page) for user management
- [ ] Frontend: Team selector for guest mode
- [ ] Frontend: Filter views by team for guest users
- [ ] Deploy & test
