package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/jobs"
	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
	"time-tracker/api/internal/spaces"
)

type TimeLogHandler struct {
	db        *pgxpool.Pool
	jobClient *asynq.Client
	spaces    *spaces.Client
}

func NewTimeLogHandler(db *pgxpool.Pool, jobClient *asynq.Client, sp *spaces.Client) *TimeLogHandler {
	return &TimeLogHandler{db: db, jobClient: jobClient, spaces: sp}
}

type createTimeLogRequest struct {
	ProjectID       *uuid.UUID `json:"project_id"`
	TaskID          *uuid.UUID `json:"task_id"`
	StartedAt       time.Time  `json:"started_at"`
	EndedAt         time.Time  `json:"ended_at"`
	DurationSeconds int        `json:"duration_seconds"`
	ActivityPercent int        `json:"activity_percent"`
	ScreenshotURL   *string    `json:"screenshot_url"`
	ThumbnailURL    *string    `json:"thumbnail_url"`
	WindowTitle     *string    `json:"window_title"`
	Notes           *string    `json:"notes"`
}

func (h *TimeLogHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)

	dateStr := r.URL.Query().Get("date")
	var rows interface {
		Close()
		Next() bool
		Scan(...any) error
	}
	var err error

	if dateStr != "" {
		date, parseErr := time.Parse("2006-01-02", dateStr)
		if parseErr != nil {
			http.Error(w, "invalid date format (use YYYY-MM-DD)", http.StatusBadRequest)
			return
		}
		rows, err = h.db.Query(r.Context(),
			`SELECT id, user_id, project_id, task_id, started_at, ended_at,
			        duration_seconds, activity_percent, screenshot_url, thumbnail_url,
			        window_title, notes, created_at
			 FROM time_logs
			 WHERE user_id=$1 AND started_at::date=$2
			 ORDER BY started_at ASC`,
			userID, date.Format("2006-01-02"),
		)
	} else {
		rows, err = h.db.Query(r.Context(),
			`SELECT id, user_id, project_id, task_id, started_at, ended_at,
			        duration_seconds, activity_percent, screenshot_url, thumbnail_url,
			        window_title, notes, created_at
			 FROM time_logs
			 WHERE user_id=$1
			 ORDER BY started_at DESC
			 LIMIT 100`,
			userID,
		)
	}
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	results := scanTimeLogs(rows)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

func (h *TimeLogHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)
	orgID := mw.OrgID(r)

	var req createTimeLogRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	if orgID == "" {
		http.Error(w, "your account is not part of an organization", http.StatusForbidden)
		return
	}

	// Authoritative enforcement of the employer's tracking policy (the desktop
	// poll reacts within ~30s; this rejects anything that slips through that gap
	// or comes from a stale/hostile client). A screenshot-less entry is a manual
	// time log and additionally requires allow_manual_time.
	var canTrack, allowManual, requireNotes bool
	var canTrackSince time.Time
	if err := h.db.QueryRow(r.Context(),
		`SELECT can_track, can_track_since, allow_manual_time, require_notes FROM users WHERE id=$1`, userID,
	).Scan(&canTrack, &canTrackSince, &allowManual, &requireNotes); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !canTrack {
		// Grandfather work captured before tracking was paused: a genuine capture
		// (carries a screenshot) whose started_at predates the pause is legitimate
		// buffered work and still syncs. Anything captured at/after the pause — or a
		// screenshot-less entry — is rejected while paused.
		grandfathered := req.ScreenshotURL != nil && req.StartedAt.Before(canTrackSince)
		if !grandfathered {
			http.Error(w, "time tracking not enabled for your account", http.StatusForbidden)
			return
		}
	}
	if req.ScreenshotURL == nil && !allowManual {
		http.Error(w, "manual time entry is not enabled for your account", http.StatusForbidden)
		return
	}
	if requireNotes && (req.Notes == nil || strings.TrimSpace(*req.Notes) == "") {
		http.Error(w, "working notes are required for your account", http.StatusUnprocessableEntity)
		return
	}

	// A project must be selected, and the caller must be a member (or owner) of a
	// project that lives in their own organization.
	if req.ProjectID == nil {
		http.Error(w, "project_id is required", http.StatusBadRequest)
		return
	}
	var allowed bool
	h.db.QueryRow(r.Context(),
		`SELECT EXISTS(
			SELECT 1 FROM projects p
			LEFT JOIN project_members pm ON pm.project_id = p.id
			WHERE p.id=$1 AND p.org_id=$2 AND (p.owner_id=$3 OR pm.user_id=$3)
		)`,
		req.ProjectID, orgID, userID,
	).Scan(&allowed)
	if !allowed {
		http.Error(w, "project not found or not assigned to you", http.StatusForbidden)
		return
	}

	var notes *string
	if req.Notes != nil {
		trimmed := strings.TrimSpace(*req.Notes)
		if trimmed != "" {
			notes = &trimmed
		}
	}

	var id uuid.UUID
	err := h.db.QueryRow(r.Context(),
		`INSERT INTO time_logs
		 (user_id, org_id, project_id, task_id, started_at, ended_at, duration_seconds,
		  activity_percent, screenshot_url, thumbnail_url, window_title, notes)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		 RETURNING id`,
		userID, orgID, req.ProjectID, req.TaskID, req.StartedAt, req.EndedAt,
		req.DurationSeconds, req.ActivityPercent, req.ScreenshotURL,
		req.ThumbnailURL, req.WindowTitle, notes,
	).Scan(&id)
	if err != nil {
		http.Error(w, "insert error", http.StatusInternalServerError)
		return
	}

	if req.ScreenshotURL != nil && req.ThumbnailURL == nil && h.jobClient != nil {
		task, err := jobs.NewThumbnailTask(id.String(), *req.ScreenshotURL)
		if err == nil {
			if _, err := h.jobClient.Enqueue(task, asynq.Queue("low")); err != nil {
				log.Printf("[timelogs] enqueue thumbnail task for %s: %v", id, err)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": id.String()})
}

// IDs returns the ids of the caller's own time logs whose started_at falls in
// [from,to] (YYYY-MM-DD; defaults to the last 14 days). The desktop uses this to
// reconcile: any locally-synced interval in that window whose api_id is absent here
// was deleted server-side (e.g. from the web Work Diary) and is removed locally.
func (h *TimeLogHandler) IDs(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)

	to := time.Now().UTC()
	from := to.AddDate(0, 0, -14)
	if s := r.URL.Query().Get("from"); s != "" {
		if t, err := time.Parse("2006-01-02", s); err == nil {
			from = t
		}
	}
	if s := r.URL.Query().Get("to"); s != "" {
		if t, err := time.Parse("2006-01-02", s); err == nil {
			to = t
		}
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT id FROM time_logs
		 WHERE user_id=$1 AND started_at::date BETWEEN $2::date AND $3::date`,
		userID, from.Format("2006-01-02"), to.Format("2006-01-02"))
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	ids := []string{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id.String())
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ids": ids})
}

func (h *TimeLogHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)
	logID := chi.URLParam(r, "id")

	row := h.db.QueryRow(r.Context(),
		`SELECT id, user_id, project_id, task_id, started_at, ended_at,
		        duration_seconds, activity_percent, screenshot_url, thumbnail_url,
		        window_title, notes, created_at
		 FROM time_logs WHERE id=$1 AND user_id=$2`,
		logID, userID,
	)

	tl, err := scanTimeLog(row)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tl)
}

// Delete removes a single time log (and its screenshots in Spaces). Authorization:
//   • god       — any log
//   • employer  — any log within their own organization (the owner can always delete)
//   • employee  — only their own log, and only when allow_delete is enabled for them
// The matching WHERE clause doubles as the access scope, so an unauthorized target
// simply matches no rows (404) rather than being deleted.
func (h *TimeLogHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)
	logID := chi.URLParam(r, "id")

	var where string
	var args []any
	switch {
	case mw.IsGod(r):
		where, args = `id=$1`, []any{logID}
	case mw.Role(r) == models.RoleEmployer:
		where, args = `id=$1 AND org_id=$2`, []any{logID, mw.OrgID(r)}
	default: // employee — gated by the employer-granted allow_delete permission
		var allowed bool
		if err := h.db.QueryRow(r.Context(),
			`SELECT allow_delete FROM users WHERE id=$1`, userID).Scan(&allowed); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if !allowed {
			http.Error(w, "deleting time logs is not enabled for your account", http.StatusForbidden)
			return
		}
		where, args = `id=$1 AND user_id=$2`, []any{logID, userID}
	}

	h.deleteSpacesObjects(r.Context(),
		`SELECT screenshot_url, thumbnail_url FROM time_logs WHERE `+where, args...)

	tag, err := h.db.Exec(r.Context(), `DELETE FROM time_logs WHERE `+where, args...)
	if err != nil || tag.RowsAffected() == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeleteAll removes every time log belonging to the authenticated employee,
// along with the screenshots/thumbnails they reference in Spaces.
func (h *TimeLogHandler) DeleteAll(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)

	h.deleteSpacesObjects(r.Context(),
		`SELECT screenshot_url, thumbnail_url FROM time_logs WHERE user_id=$1`, userID)

	_, err := h.db.Exec(r.Context(), `DELETE FROM time_logs WHERE user_id=$1`, userID)
	if err != nil {
		http.Error(w, "delete error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteSpacesObjects best-effort removes the screenshot/thumbnail objects for
// the rows matched by query. Errors are logged, not fatal — the DB delete is the
// source of truth. No-op when Spaces isn't configured.
func (h *TimeLogHandler) deleteSpacesObjects(ctx context.Context, query string, args ...any) {
	if h.spaces == nil {
		return
	}
	rows, err := h.db.Query(ctx, query, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var shot, thumb *string
		if err := rows.Scan(&shot, &thumb); err != nil {
			continue
		}
		for _, u := range []*string{shot, thumb} {
			if u == nil || *u == "" {
				continue
			}
			if err := h.spaces.DeleteByURL(ctx, *u); err != nil {
				log.Printf("[timelogs] spaces delete %s: %v", *u, err)
			}
		}
	}
}

// scanTimeLog / scanTimeLogs helpers avoid repetition.

type scanner interface {
	Scan(...any) error
}

type rowsScanner interface {
	Close()
	Next() bool
	Scan(...any) error
}

func scanTimeLog(row scanner) (map[string]any, error) {
	var (
		id, userID                  uuid.UUID
		projectID, taskID           *uuid.UUID
		startedAt, endedAt, created time.Time
		durSec, actPct              int
		screenshotURL, thumbnailURL *string
		windowTitle, notes          *string
	)
	err := row.Scan(
		&id, &userID, &projectID, &taskID, &startedAt, &endedAt,
		&durSec, &actPct, &screenshotURL, &thumbnailURL, &windowTitle, &notes, &created,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"id":               id,
		"user_id":          userID,
		"project_id":       projectID,
		"task_id":          taskID,
		"started_at":       startedAt,
		"ended_at":         endedAt,
		"duration_seconds": durSec,
		"activity_percent": actPct,
		"screenshot_url":   screenshotURL,
		"thumbnail_url":    thumbnailURL,
		"window_title":     windowTitle,
		"notes":            notes,
		"created_at":       created,
	}, nil
}

func scanTimeLogs(rows rowsScanner) []map[string]any {
	var results []map[string]any
	for rows.Next() {
		tl, err := scanTimeLog(rows)
		if err == nil {
			results = append(results, tl)
		}
	}
	if results == nil {
		results = []map[string]any{}
	}
	return results
}
