package db

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Connect(ctx context.Context) (*pgxpool.Pool, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return nil, fmt.Errorf("DATABASE_URL not set")
	}

	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}

	return pool, nil
}

const schema = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'employee',
    can_track   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS can_track BOOLEAN NOT NULL DEFAULT false;

-- Human full name (e.g. "Ram Kumar Prasad"). Empty for legacy rows; the UI falls
-- back to email when blank. Normalized (trimmed, single-spaced, <=30 chars) on write.
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';

-- Default billable rate for an employee's time (cents/hour); used as a fallback
-- when a time log's project has no rate of its own.
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate_cents INTEGER NOT NULL DEFAULT 0;

-- Whether the employee may log manual (screenshot-less) time. Off by default:
-- the desktop only allows manual entry, and the API only accepts screenshot-less
-- time logs, when an employer turns this on.
ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_manual_time BOOLEAN NOT NULL DEFAULT false;

-- Whether the employee may delete their own time logs (and the screenshots they
-- reference) from the web Work Diary. Off by default — the employer opts in per
-- employee. The org owner can always delete; this only gates employee self-deletion.
ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_delete BOOLEAN NOT NULL DEFAULT false;

-- When the current can_track value took effect (updated on every toggle). Lets the
-- API "grandfather" buffered screenshots captured before tracking was paused: such
-- logs still sync while paused, whereas post-pause writes are rejected.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_track_since TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS projects (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Billable rate for work on this project (cents/hour); overrides the employee's
-- default rate when set (> 0).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hourly_rate_cents INTEGER NOT NULL DEFAULT 0;

-- Optional billing budget for this project (cents); 0 means no budget. The
-- employer is warned as consumed billable approaches/exceeds it.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_cents BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS project_members (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS time_logs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id       UUID REFERENCES projects(id) ON DELETE SET NULL,
    task_id          UUID REFERENCES tasks(id) ON DELETE SET NULL,
    started_at       TIMESTAMPTZ NOT NULL,
    ended_at         TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER NOT NULL,
    activity_percent INTEGER NOT NULL DEFAULT 0,
    screenshot_url   TEXT,
    thumbnail_url    TEXT,
    window_title     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS time_logs_user_started ON time_logs (user_id, started_at DESC);

-- Multi-tenancy: each organization has one owner (an employer); every user,
-- project and time log belongs to at most one organization. org_id is nullable:
-- the god super-admin and released (org-less) users have NULL.
CREATE TABLE IF NOT EXISTS organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users     ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE projects  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- Employer can require employees to always enter working notes on each captured
-- interval. Off by default; enforced server-side on POST /time-logs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS require_notes BOOLEAN NOT NULL DEFAULT false;

-- Free-text notes the employee attaches to each captured interval (what they were
-- working on). Visible in the Work Diary lightbox for both the employee and employer.
ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE INDEX IF NOT EXISTS users_org     ON users (org_id);
CREATE INDEX IF NOT EXISTS projects_org  ON projects (org_id);
CREATE INDEX IF NOT EXISTS time_logs_org ON time_logs (org_id, started_at DESC);

-- Password reset tokens: one-time, short-lived tokens for the forgot-password flow.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);

-- Process/application name captured alongside the window title on each interval.
ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS app_name TEXT;

-- Per-org app categorization: employers tag app names as productive/neutral/unproductive.
CREATE TABLE IF NOT EXISTS app_categories (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    app_name   TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT 'neutral',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, app_name)
);
CREATE INDEX IF NOT EXISTS app_categories_org ON app_categories(org_id);

-- Timesheets: weekly periods employees submit for employer approval.
-- status: draft → submitted → approved | rejected
-- Auto-approves the Monday after the week ends if the employer hasn't acted by Sunday.
CREATE TABLE IF NOT EXISTS timesheets (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    week_start    DATE NOT NULL,
    status        TEXT NOT NULL DEFAULT 'draft',
    employee_note TEXT,
    employer_note TEXT,
    submitted_at  TIMESTAMPTZ,
    reviewed_at   TIMESTAMPTZ,
    reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    auto_approved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, week_start)
);
CREATE INDEX IF NOT EXISTS timesheets_org_week ON timesheets(org_id, week_start DESC);
CREATE INDEX IF NOT EXISTS timesheets_status   ON timesheets(status) WHERE status = 'submitted';
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS total_billable_cents BIGINT NOT NULL DEFAULT 0;

-- Break policy (per employee, employer-controlled). Surfaced via GET /me/policy so
-- the desktop knows whether breaks are allowed and for how long. breaks_per_day /
-- break_daily_minutes of 0 mean "unlimited".
ALTER TABLE users ADD COLUMN IF NOT EXISTS breaks_enabled         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS break_duration_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE users ADD COLUMN IF NOT EXISTS breaks_per_day         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS break_daily_minutes    INTEGER NOT NULL DEFAULT 0;

-- Extra Claims: reimbursement claims an employee raises (title, optional
-- description, money amount, supporting documents). status: pending → approved |
-- rejected. Approved claims dated within an invoice's range are billed on it.
-- documents is a JSON array of {name, url, content_type}.
CREATE TABLE IF NOT EXISTS claims (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    description   TEXT,
    amount_cents  BIGINT NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'pending',
    documents     JSONB NOT NULL DEFAULT '[]',
    employer_note TEXT,
    reviewed_at   TIMESTAMPTZ,
    reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS claims_org_status ON claims(org_id, status);
CREATE INDEX IF NOT EXISTS claims_user ON claims(user_id, created_at DESC);
`

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, schema)
	return err
}

// BackfillDefaultOrg is a one-time migration of pre-multi-tenant data: if no
// organization exists yet, it creates a single "Default Organization" owned by
// the oldest employer and folds every org-less, non-god user/project/time-log
// into it. This preserves the previous global-visibility behaviour on upgrade.
//
// It is a no-op once any organization exists, so later-released users (org_id
// NULL by design) are never re-attached. Safe to call on every startup.
func BackfillDefaultOrg(ctx context.Context, pool *pgxpool.Pool) error {
	var orgCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM organizations`).Scan(&orgCount); err != nil {
		return fmt.Errorf("count orgs: %w", err)
	}
	if orgCount > 0 {
		return nil // already migrated (or orgs created via signup) — leave as-is
	}

	var ownerID string
	err := pool.QueryRow(ctx,
		`SELECT id FROM users WHERE role='employer' ORDER BY created_at ASC LIMIT 1`,
	).Scan(&ownerID)
	if err != nil {
		// No employer to own a default org yet (e.g. only god/employees exist).
		// Nothing to backfill; a fresh org will be created on first signup.
		return nil
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin backfill: %w", err)
	}
	defer tx.Rollback(ctx)

	var orgID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO organizations (name, owner_id) VALUES ('Default Organization', $1) RETURNING id`,
		ownerID,
	).Scan(&orgID); err != nil {
		return fmt.Errorf("create default org: %w", err)
	}

	// Everyone except god, and every existing project/time log, joins the default org.
	for _, q := range []string{
		`UPDATE users     SET org_id=$1 WHERE org_id IS NULL AND role <> 'god'`,
		`UPDATE projects  SET org_id=$1 WHERE org_id IS NULL`,
		`UPDATE time_logs SET org_id=$1 WHERE org_id IS NULL`,
	} {
		if _, err := tx.Exec(ctx, q, orgID); err != nil {
			return fmt.Errorf("backfill org_id: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit backfill: %w", err)
	}
	return nil
}
