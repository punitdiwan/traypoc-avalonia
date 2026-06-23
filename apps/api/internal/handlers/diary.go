package handlers

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
)

type DiaryHandler struct {
	db *pgxpool.Pool
}

func NewDiaryHandler(db *pgxpool.Pool) *DiaryHandler {
	return &DiaryHandler{db: db}
}

type diarySlot struct {
	ID              uuid.UUID  `json:"id"`
	Hour            int        `json:"hour"`
	StartedAt       time.Time  `json:"started_at"`
	EndedAt         time.Time  `json:"ended_at"`
	DurationSeconds int        `json:"duration_seconds"`
	ActivityPercent int        `json:"activity_percent"`
	ScreenshotURL   *string    `json:"screenshot_url"`
	ThumbnailURL    *string    `json:"thumbnail_url"`
	WindowTitle     *string    `json:"window_title"`
	AppName         *string    `json:"app_name"`
	Notes           *string    `json:"notes"`
	ProjectID       *uuid.UUID `json:"project_id"`
	TaskID          *uuid.UUID `json:"task_id"`
}

type hourBucket struct {
	Hour         int         `json:"hour"`
	TotalSeconds int         `json:"total_seconds"`
	AvgActivity  int         `json:"avg_activity"`
	Slots        []diarySlot `json:"slots"`
}

type dailyDiary struct {
	Date  string       `json:"date"`
	Hours []hourBucket `json:"hours"`
}

// Get returns the hourly work diary for a given user over a date range.
// Query params:
//   - from=YYYY-MM-DD, to=YYYY-MM-DD  (date range, inclusive)
//   - date=YYYY-MM-DD                  (legacy single-date alias; sets from=to=date)
//
// If none are provided, defaults to today (UTC).
func (h *DiaryHandler) Get(w http.ResponseWriter, r *http.Request) {
	targetUserID := chi.URLParam(r, "userId")

	// Parse date range. Support legacy ?date= as well as ?from=&to=.
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")
	if fromStr == "" {
		if d := r.URL.Query().Get("date"); d != "" {
			fromStr = d
		}
	}
	if toStr == "" {
		toStr = fromStr
	}

	var from, to time.Time
	if fromStr == "" {
		from = time.Now().UTC().Truncate(24 * time.Hour)
		to = from
	} else {
		var err error
		from, err = time.Parse("2006-01-02", fromStr)
		if err != nil {
			http.Error(w, "invalid from/date format (use YYYY-MM-DD)", http.StatusBadRequest)
			return
		}
		to, err = time.Parse("2006-01-02", toStr)
		if err != nil {
			http.Error(w, "invalid to format (use YYYY-MM-DD)", http.StatusBadRequest)
			return
		}
		if to.Before(from) {
			from, to = to, from
		}
	}

	// Auth: restrict to the caller's org. Employees may only read their own diary.
	orgFilter := ""
	args := []any{targetUserID, from.Format("2006-01-02"), to.Format("2006-01-02")}
	if !mw.IsGod(r) {
		if mw.Role(r) == models.RoleEmployee {
			if targetUserID != mw.UserID(r) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		} else {
			var exists bool
			if err := h.db.QueryRow(r.Context(),
				`SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='employee' AND org_id=$2)`,
				targetUserID, mw.OrgID(r),
			).Scan(&exists); err != nil || !exists {
				http.Error(w, "employee not found", http.StatusNotFound)
				return
			}
		}
		orgFilter = " AND org_id=$4"
		args = append(args, mw.OrgID(r))
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT
		    id,
		    (started_at AT TIME ZONE 'UTC')::date AS log_date,
		    EXTRACT(HOUR FROM started_at AT TIME ZONE 'UTC')::int AS hour,
		    started_at, ended_at, duration_seconds, activity_percent,
		    screenshot_url, thumbnail_url, window_title, app_name, notes,
		    project_id, task_id
		 FROM time_logs
		 WHERE user_id=$1
		   AND started_at::date >= $2::date
		   AND started_at::date <= $3::date`+orgFilter+`
		 ORDER BY started_at ASC`,
		args...,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	// Build a map: date string → hour → slots.
	type dateHourKey struct {
		date string
		hour int
	}
	slotMap := make(map[dateHourKey][]diarySlot)
	dateSet := make(map[string]struct{})

	for rows.Next() {
		var s diarySlot
		var logDate time.Time
		err := rows.Scan(
			&s.ID, &logDate, &s.Hour, &s.StartedAt, &s.EndedAt, &s.DurationSeconds,
			&s.ActivityPercent, &s.ScreenshotURL, &s.ThumbnailURL,
			&s.WindowTitle, &s.AppName, &s.Notes, &s.ProjectID, &s.TaskID,
		)
		if err != nil {
			continue
		}
		dateStr := logDate.Format("2006-01-02")
		key := dateHourKey{date: dateStr, hour: s.Hour}
		slotMap[key] = append(slotMap[key], s)
		dateSet[dateStr] = struct{}{}
	}

	// Build a sorted list of dates that have data.
	dates := make([]string, 0, len(dateSet))
	for d := range dateSet {
		dates = append(dates, d)
	}
	sort.Strings(dates)

	// Assemble daily diary entries.
	days := make([]dailyDiary, 0, len(dates))
	for _, d := range dates {
		// Collect all hours for this date.
		hourMap := make(map[int][]diarySlot)
		for key, slots := range slotMap {
			if key.date == d {
				hourMap[key.hour] = slots
			}
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
		sort.Slice(buckets, func(i, j int) bool { return buckets[i].Hour < buckets[j].Hour })

		days = append(days, dailyDiary{Date: d, Hours: buckets})
	}

	resp := map[string]any{
		"user_id": targetUserID,
		"from":    from.Format("2006-01-02"),
		"to":      to.Format("2006-01-02"),
		"days":    days,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
