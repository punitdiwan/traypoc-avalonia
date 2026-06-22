package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
)

type CallHandler struct {
	db *pgxpool.Pool
}

func NewCallHandler(db *pgxpool.Pool) *CallHandler {
	return &CallHandler{db: db}
}

const callSelectCols = `
	c.id, c.org_id, c.caller_id, c.callee_id,
	COALESCE(caller.full_name, caller.email) AS caller_name,
	COALESCE(callee.full_name, callee.email) AS callee_name,
	c.status, c.started_at, c.answered_at, c.ended_at, c.duration_seconds,
	(SELECT r.storage_url FROM call_recordings r WHERE r.call_id = c.id ORDER BY r.created_at DESC LIMIT 1)
`

func scanCall(row interface{ Scan(...any) error }) (*models.Call, error) {
	var c models.Call
	err := row.Scan(
		&c.ID, &c.OrgID, &c.CallerID, &c.CalleeID,
		&c.CallerName, &c.CalleeName,
		&c.Status, &c.StartedAt, &c.AnsweredAt, &c.EndedAt, &c.DurationSeconds,
		&c.RecordingURL,
	)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// List returns call history scoped to the caller:
//   - employee: calls they were part of (caller or callee)
//   - employer: every call in their org
//   - god: everything
// Optional ?user_id= filters an employer/god view to one employee.
func (h *CallHandler) List(w http.ResponseWriter, r *http.Request) {
	var (
		query string
		args  []any
	)
	base := `SELECT ` + callSelectCols + `
		FROM calls c
		JOIN users caller ON caller.id = c.caller_id
		JOIN users callee ON callee.id = c.callee_id`

	switch {
	case mw.Role(r) == models.RoleEmployee:
		query = base + ` WHERE c.caller_id = $1 OR c.callee_id = $1
			ORDER BY c.started_at DESC LIMIT 200`
		args = []any{mw.UserID(r)}
	case mw.IsGod(r):
		query = base + ` ORDER BY c.started_at DESC LIMIT 500`
	default: // employer
		if uid := r.URL.Query().Get("user_id"); uid != "" {
			query = base + ` WHERE c.org_id = $1 AND (c.caller_id = $2 OR c.callee_id = $2)
				ORDER BY c.started_at DESC LIMIT 500`
			args = []any{mw.OrgID(r), uid}
		} else {
			query = base + ` WHERE c.org_id = $1 ORDER BY c.started_at DESC LIMIT 500`
			args = []any{mw.OrgID(r)}
		}
	}

	rows, err := h.db.Query(r.Context(), query, args...)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	result := []models.Call{}
	for rows.Next() {
		c, err := scanCall(rows)
		if err != nil {
			continue
		}
		result = append(result, *c)
	}
	writeJSON(w, result)
}

// writeJSON is a tiny shared helper for JSON responses.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
