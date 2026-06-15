package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/jobs"
	mw "time-tracker/api/internal/middleware"
)

type TimeLogHandler struct {
	db        *pgxpool.Pool
	jobClient *asynq.Client
}

func NewTimeLogHandler(db *pgxpool.Pool, jobClient *asynq.Client) *TimeLogHandler {
	return &TimeLogHandler{db: db, jobClient: jobClient}
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
			        window_title, created_at
			 FROM time_logs
			 WHERE user_id=$1 AND started_at::date=$2
			 ORDER BY started_at ASC`,
			userID, date.Format("2006-01-02"),
		)
	} else {
		rows, err = h.db.Query(r.Context(),
			`SELECT id, user_id, project_id, task_id, started_at, ended_at,
			        duration_seconds, activity_percent, screenshot_url, thumbnail_url,
			        window_title, created_at
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

	var req createTimeLogRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	var id uuid.UUID
	err := h.db.QueryRow(r.Context(),
		`INSERT INTO time_logs
		 (user_id, project_id, task_id, started_at, ended_at, duration_seconds,
		  activity_percent, screenshot_url, thumbnail_url, window_title)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		 RETURNING id`,
		userID, req.ProjectID, req.TaskID, req.StartedAt, req.EndedAt,
		req.DurationSeconds, req.ActivityPercent, req.ScreenshotURL,
		req.ThumbnailURL, req.WindowTitle,
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

func (h *TimeLogHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)
	logID := chi.URLParam(r, "id")

	row := h.db.QueryRow(r.Context(),
		`SELECT id, user_id, project_id, task_id, started_at, ended_at,
		        duration_seconds, activity_percent, screenshot_url, thumbnail_url,
		        window_title, created_at
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

func (h *TimeLogHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)
	logID := chi.URLParam(r, "id")

	tag, err := h.db.Exec(r.Context(),
		`DELETE FROM time_logs WHERE id=$1 AND user_id=$2`, logID, userID)
	if err != nil || tag.RowsAffected() == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeleteAll removes every time log belonging to the authenticated employee.
func (h *TimeLogHandler) DeleteAll(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)
	_, err := h.db.Exec(r.Context(), `DELETE FROM time_logs WHERE user_id=$1`, userID)
	if err != nil {
		http.Error(w, "delete error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
		id, userID                   uuid.UUID
		projectID, taskID            *uuid.UUID
		startedAt, endedAt, created  time.Time
		durSec, actPct               int
		screenshotURL, thumbnailURL  *string
		windowTitle                  *string
	)
	err := row.Scan(
		&id, &userID, &projectID, &taskID, &startedAt, &endedAt,
		&durSec, &actPct, &screenshotURL, &thumbnailURL, &windowTitle, &created,
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
