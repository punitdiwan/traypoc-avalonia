package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
)

type DiaryHandler struct {
	db *pgxpool.Pool
}

func NewDiaryHandler(db *pgxpool.Pool) *DiaryHandler {
	return &DiaryHandler{db: db}
}

type diarySlot struct {
	Hour            int        `json:"hour"`
	StartedAt       time.Time  `json:"started_at"`
	EndedAt         time.Time  `json:"ended_at"`
	DurationSeconds int        `json:"duration_seconds"`
	ActivityPercent int        `json:"activity_percent"`
	ScreenshotURL   *string    `json:"screenshot_url"`
	ThumbnailURL    *string    `json:"thumbnail_url"`
	WindowTitle     *string    `json:"window_title"`
	ProjectID       *uuid.UUID `json:"project_id"`
	TaskID          *uuid.UUID `json:"task_id"`
}

// Get returns the hourly work diary for a given user on a given date.
// Query param: date=YYYY-MM-DD (defaults to today UTC).
func (h *DiaryHandler) Get(w http.ResponseWriter, r *http.Request) {
	targetUserID := chi.URLParam(r, "userId")

	dateStr := r.URL.Query().Get("date")
	var date time.Time
	if dateStr == "" {
		date = time.Now().UTC().Truncate(24 * time.Hour)
	} else {
		var err error
		date, err = time.Parse("2006-01-02", dateStr)
		if err != nil {
			http.Error(w, "invalid date format (use YYYY-MM-DD)", http.StatusBadRequest)
			return
		}
	}

	// Restrict to the caller's organization (god sees any user's diary).
	orgFilter := ""
	args := []any{targetUserID, date.Format("2006-01-02")}
	if !mw.IsGod(r) {
		orgFilter = " AND org_id=$3"
		args = append(args, mw.OrgID(r))
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT
		    EXTRACT(HOUR FROM started_at AT TIME ZONE 'UTC')::int AS hour,
		    started_at, ended_at, duration_seconds, activity_percent,
		    screenshot_url, thumbnail_url, window_title,
		    project_id, task_id
		 FROM time_logs
		 WHERE user_id=$1
		   AND started_at::date = $2::date`+orgFilter+`
		 ORDER BY started_at ASC`,
		args...,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	// Build hour-keyed map (0-23), each bucket holds its slots.
	hourMap := make(map[int][]diarySlot)
	for rows.Next() {
		var s diarySlot
		err := rows.Scan(
			&s.Hour, &s.StartedAt, &s.EndedAt, &s.DurationSeconds,
			&s.ActivityPercent, &s.ScreenshotURL, &s.ThumbnailURL,
			&s.WindowTitle, &s.ProjectID, &s.TaskID,
		)
		if err != nil {
			continue
		}
		hourMap[s.Hour] = append(hourMap[s.Hour], s)
	}

	type hourBucket struct {
		Hour            int         `json:"hour"`
		TotalSeconds    int         `json:"total_seconds"`
		AvgActivity     int         `json:"avg_activity"`
		Slots           []diarySlot `json:"slots"`
	}

	buckets := make([]hourBucket, 0, len(hourMap))
	for h, slots := range hourMap {
		totalSec, totalAct := 0, 0
		for _, s := range slots {
			totalSec += s.DurationSeconds
			totalAct += s.ActivityPercent
		}
		avgAct := 0
		if len(slots) > 0 {
			avgAct = totalAct / len(slots)
		}
		buckets = append(buckets, hourBucket{
			Hour:         h,
			TotalSeconds: totalSec,
			AvgActivity:  avgAct,
			Slots:        slots,
		})
	}

	// Sort by hour ascending.
	for i := 0; i < len(buckets); i++ {
		for j := i + 1; j < len(buckets); j++ {
			if buckets[j].Hour < buckets[i].Hour {
				buckets[i], buckets[j] = buckets[j], buckets[i]
			}
		}
	}

	resp := map[string]any{
		"user_id": targetUserID,
		"date":    date.Format("2006-01-02"),
		"hours":   buckets,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
