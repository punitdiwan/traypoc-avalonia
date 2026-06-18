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

-- Default billable rate for an employee's time (cents/hour); used as a fallback
-- when a time log's project has no rate of its own.
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS projects (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Billable rate for work on this project (cents/hour); overrides the employee's
-- default rate when set (> 0).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS hourly_rate_cents INTEGER NOT NULL DEFAULT 0;

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

CREATE INDEX IF NOT EXISTS users_org     ON users (org_id);
CREATE INDEX IF NOT EXISTS projects_org  ON projects (org_id);
CREATE INDEX IF NOT EXISTS time_logs_org ON time_logs (org_id, started_at DESC);
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
