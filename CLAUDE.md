# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Platform-independent desktop time tracker (Upwork-style) with screenshot capture, activity monitoring, and DigitalOcean Spaces upload. Developed on Linux, primary target is Windows. Built as a **pnpm monorepo**.

The desktop app is an **Avalonia / .NET** port of the original Tauri/Rust app (the upstream `~/time-tracker` repo). The web dashboard (React + Vite) and API server (Go) are shared and were brought over from that repo unchanged.

## Monorepo Structure

```
time-tracker/                 # (this repo; dir is currently "dot-net-test")
├── apps/
│   ├── desktop/          # Avalonia / .NET desktop app (net10.0) — assembly "TrayPoc"
│   │   ├── Services/     # tracker, screenshot, activity, sync, db, uploader, api client
│   │   ├── ViewModels/   # MVVM (CommunityToolkit.Mvvm)
│   │   ├── Views/        # Login, Dashboard, WorkDiary, Settings + MainWindow
│   │   └── Assets/       # tray icons (ico + PNGs)
│   ├── web/              # Employer dashboard (React + Vite) — @time-tracker/web
│   └── api/              # Go backend (chi + pgx + asynq)
├── packaging/            # AppImage (linux) + WiX v5 MSI (windows) for the desktop app
├── pnpm-workspace.yaml   # apps/*
└── TrayPoc.slnx          # .NET solution (apps/desktop/TrayPoc.csproj)
```

Node/pnpm are pinned via `.nvmrc` (Node 24) and the root `packageManager` field (pnpm 10).

## Build & Dev Commands

Convenience scripts from the repo root: `pnpm web`, `pnpm api`, `pnpm desktop`.

### Desktop App (Avalonia / .NET)
```bash
dotnet run --project apps/desktop/TrayPoc.csproj   # or: pnpm desktop
dotnet build apps/desktop/TrayPoc.csproj -c Release
apps/desktop/bin/Debug/net10.0/TrayPoc --selftest  # headless smoke test (capture/SQLite/activity)
```
Targets `net10.0`. .NET SDK is installed user-locally under `~/.dotnet` (no root). Packaging: `packaging/linux/build-appimage.sh` (AppImage) and `packaging/windows/TrayPoc.Installer` (WiX v5 MSI, Windows-only).

### Backend API (Go)
```bash
cd apps/api
cp .env.example .env   # fill in DB/Redis/JWT values
go run ./cmd/server    # dev server on :8080   (or: make run / pnpm api)
go build ./...
go test ./...
go vet ./...
```

### Web Dashboard (React + Vite)
```bash
pnpm install           # from repo root (workspace)
pnpm web               # Vite dev server on :5173 (proxies /api → :8080)
pnpm web:build         # tsc + vite production build
```

## Architecture

### Desktop App (`apps/desktop/`) — Avalonia / .NET

A background tracker loop runs separately from the Avalonia UI thread. Key services in `apps/desktop/Services/`:

- **TrackerService.cs** — main loop: on each interval captures a screenshot, samples activity, writes to SQLite, enqueues upload
- **ScreenshotService.cs** — screen capture → full-res PNG + compressed JPEG thumbnail via **ImageSharp** (pinned 3.1.x; 4.x needs a paid license key). On Linux uses `gnome-screenshot`/`import`
- **ActivityMonitor.cs** — activity % from **OS idle sampling** (`GetLastInputInfo` on Windows, `xprintidle` on Linux) — not the Rust app's evdev/rdev event hooks; same output, different mechanism
- **WindowTitle.cs** — active-window title (Win32 on Windows, `_NET_ACTIVE_WINDOW` on Linux)
- **SpacesUploader.cs** — DO Spaces upload via **AWSSDK.S3** (S3-compatible)
- **Database.cs** — SQLite (Microsoft.Data.Sqlite); local source of truth, synced to API asynchronously
- **ApiClient.cs** — login / refresh / time-logs against the Go API
- **SyncService.cs** — pushes pending intervals to the API (~30s)
- **AuthService / ConfigStore / AppPaths / AutostartService / UpdateService / SelfTest** — auth state, JSON config, paths, autostart, self-update, headless self-test

UI is MVVM (CommunityToolkit.Mvvm) — `ViewModels/` + `Views/` (Login, Dashboard, WorkDiary, Settings). Single-instance via named Mutex + named pipe (see `Program.cs`).

### Backend API (`apps/api/`) — Go

chi router + pgx (PostgreSQL) + asynq (Redis-backed job queue):

```
cmd/server/main.go          # entry point, router wiring
internal/
  auth/auth.go              # bcrypt + JWT (HS256) issue/validate
  db/db.go                  # pgxpool connect + inline schema migration
  handlers/
    auth.go                 # POST /auth/register|login|refresh|logout, GET /auth/me
    timelogs.go             # GET|POST|DELETE /time-logs[/:id]
    projects.go             # GET|POST /projects, tasks, members
    diary.go                # GET /diary/:userId  (employer-only)
  middleware/auth.go        # RequireAuth (Bearer JWT), RequireRole
  jobs/
    tasks.go                # asynq task definitions + handlers
    workers.go              # asynq server startup
```

Routes summary:
- `POST /auth/register|login` — issues access token (body) + refresh token (httpOnly cookie for web, also in body for desktop)
- `POST /auth/refresh` — accepts refresh token in body `{"refresh_token":"..."}` OR httpOnly cookie
- `GET /time-logs?date=YYYY-MM-DD` — employee's own logs
- `POST /time-logs` — desktop app syncs intervals here
- `GET /projects`, `POST /projects` (employer only)
- `GET /diary/:userId?date=YYYY-MM-DD` — employer-only, hourly buckets with thumbnails
- `GET /overview?days=N` (or `?from=&to=`) — employer-only team aggregate: zero-filled daily series + per-employee + per-project totals, all with `billable_cents`; powers the dashboard charts and Reports
- `GET /invoice?user_id=&from=&to=` — employer-only billable timesheet for one employee, line items grouped by project
- `PATCH /projects/:id` — employer-only, update project `{name?, hourly_rate_cents?}`
- `GET /users` — employer-only, list all employees
- `PATCH /users/:id/can-track` — employer-only, toggle `{"can_track": true/false}` per employee
- `PATCH /users/:id/rate` — employer-only, set employee default `{"hourly_rate_cents": N}`

**Billing:** rates are stored as integer cents/hour on `projects.hourly_rate_cents` and `users.hourly_rate_cents`. A time log's billable rate = the project's rate when set (> 0), else the employee's default rate; amount = `seconds × rate / 3600`. Currency is org-wide via the `CURRENCY` env (ISO 4217, default `INR`); the web app formats cents with `Intl.NumberFormat`.
- asynq jobs: `report:weekly`, `screenshot:thumbnail`

**Desktop login guard:** `POST /auth/login` returns 403 if the employee has `can_track = false`. Employers must enable tracking via the web dashboard before an employee can log in on the desktop.

### Web Dashboard (`apps/web/`) — React + Vite

Employer-only SPA (light/dark themed via Tailwind `class` strategy; theme persisted in `lib/theme.ts`):
- `/login` — email/password → stores access token in localStorage, refresh in httpOnly cookie
- `/dashboard` — team overview: headline stats (incl. billable) + recharts (hours/day bar, activity/day area) + per-project breakdown + per-employee table; lazy-loaded so recharts ships in its own chunk
- `/reports` — custom date-range report with by-employee/by-project tables, CSV export, and per-employee invoice links
- `/invoice/:userId?from=&to=` — print-friendly billable timesheet (uses `@media print` + `.no-print`; "Print / Save as PDF" calls `window.print()`)
- `/manage` — list/create projects (with rate), invite employees, toggle tracking, edit project + employee billable rates inline
- `/diary/:userId` — date nav (prev/next/today) + project filter + hourly timeline; thumbnails open a keyboard-navigable screenshot lightbox (`components/Lightbox.tsx`)
- Vite dev proxy: `/api/*` → `http://localhost:8080` (strips `/api` prefix), target overridable via `VITE_API_TARGET`

### Key Data Flow

```
Desktop tracker fires
  → captures screenshot + activity
  → writes TimeInterval row to SQLite
  → uploads PNG to DO Spaces (path: {userId}/{date}/{timestamp}.png)
  → SyncService POSTs interval + Spaces URL to the API
  → API writes to PostgreSQL
```

Offline: SQLite buffers everything. Sync resumes when the API is reachable.

## Environment Variables

Desktop app config/data live in `ApplicationData/time-tracker/` as **JSON** (distinct
filenames from the Rust app's `*.toml`, so both can coexist):

- `config.json` — DO Spaces creds + tracker settings (api_url, spaces_*, capture/idle intervals), edited via Settings
- `auth.json` — access/refresh tokens + user info, written on login, never shown in UI
- `tracker.db` — local SQLite database

API reads from `.env` (see `apps/api/.env.example`): `DATABASE_URL`, `REDIS_URL`,
`JWT_SECRET`, `PORT`, `CORS_ORIGIN`, `CURRENCY` (billing currency, default `INR`),
`DO_SPACES_*`, `SMTP_*`, `SEED_*`.

## Cross-Platform Notes

- Windows-first for OS-specific code; Linux is best-effort; macOS not yet supported (capture/permissions/idle).
- Screenshot: Windows native capture; Linux shells out to `gnome-screenshot`/`import`.
- Idle/activity: `GetLastInputInfo` (Windows) / `xprintidle` (Linux).
- Always use `System.IO.Path.Combine`, never string concatenation, for paths.
