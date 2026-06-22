package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
)

// PolicyHandler serves the live per-user policy snapshot the desktop app polls
// (off its UI thread) so it reacts to employer-side changes without a re-login:
// tracking being toggled off, manual-time being allowed/disallowed, and project
// rate changes. The server remains authoritative — this endpoint is for the
// client's responsiveness, not for enforcement (see timelogs.Create / refresh).
type PolicyHandler struct {
	db *pgxpool.Pool
}

func NewPolicyHandler(db *pgxpool.Pool) *PolicyHandler {
	return &PolicyHandler{db: db}
}

type policyProject struct {
	ID              uuid.UUID `json:"id"`
	Name            string    `json:"name"`
	HourlyRateCents int       `json:"hourly_rate_cents"`
}

// Get returns {can_track, allow_manual_time, projects[]} for the caller.
func (h *PolicyHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)

	var canTrack, allowManual, requireNotes, breaksEnabled bool
	var breakDuration, breaksPerDay, breakDailyMinutes int
	if err := h.db.QueryRow(r.Context(),
		`SELECT can_track, allow_manual_time, require_notes,
		        breaks_enabled, break_duration_minutes, breaks_per_day, break_daily_minutes
		 FROM users WHERE id=$1`, userID,
	).Scan(&canTrack, &allowManual, &requireNotes,
		&breaksEnabled, &breakDuration, &breaksPerDay, &breakDailyMinutes); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	// Project list mirrors GET /projects: god sees all; otherwise the caller's own
	// org projects they own or are assigned to. Rates are included so the desktop
	// can display the current per-hour rate after an employer edits it.
	var (
		rows interface {
			Close()
			Next() bool
			Scan(...any) error
		}
		err error
	)
	if mw.IsGod(r) {
		rows, err = h.db.Query(r.Context(),
			`SELECT id, name, hourly_rate_cents, created_at FROM projects ORDER BY created_at DESC`)
	} else {
		// created_at must be in the SELECT list because DISTINCT + ORDER BY on a
		// non-selected column is rejected by Postgres. It's scanned into a discard.
		rows, err = h.db.Query(r.Context(),
			`SELECT DISTINCT p.id, p.name, p.hourly_rate_cents, p.created_at
			 FROM projects p
			 LEFT JOIN project_members pm ON pm.project_id = p.id
			 WHERE p.org_id=$1 AND (p.owner_id=$2 OR pm.user_id=$2)
			 ORDER BY p.created_at DESC`,
			mw.OrgID(r), userID,
		)
	}
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	projects := []policyProject{}
	for rows.Next() {
		var p policyProject
		var createdAt time.Time // selected only to satisfy DISTINCT + ORDER BY
		if err := rows.Scan(&p.ID, &p.Name, &p.HourlyRateCents, &createdAt); err == nil {
			projects = append(projects, p)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"can_track":              canTrack,
		"allow_manual_time":      allowManual,
		"require_notes":          requireNotes,
		"breaks_enabled":         breaksEnabled,
		"break_duration_minutes": breakDuration,
		"breaks_per_day":         breaksPerDay,
		"break_daily_minutes":    breakDailyMinutes,
		"projects":               projects,
	})
}
