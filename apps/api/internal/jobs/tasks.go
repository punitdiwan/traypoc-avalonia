package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/report"
	"time-tracker/api/internal/spaces"
)

const (
	TypeWeeklyReportDispatch  = "report:dispatch"
	TypeWeeklyReport          = "report:weekly"
	TypeThumbnail             = "screenshot:thumbnail"
	TypeTimesheetAutoApprove  = "timesheet:auto-approve"
)

// ── Payloads ──────────────────────────────────────────────────────────────────

type WeeklyReportPayload struct {
	UserID string `json:"user_id"`
	Email  string `json:"email"`
}

type ThumbnailPayload struct {
	TimeLogID     string `json:"time_log_id"`
	ScreenshotURL string `json:"screenshot_url"`
}

// ── Task constructors ─────────────────────────────────────────────────────────

func NewWeeklyReportTask(userID, email string) (*asynq.Task, error) {
	payload, err := json.Marshal(WeeklyReportPayload{UserID: userID, Email: email})
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TypeWeeklyReport, payload), nil
}

func NewThumbnailTask(timeLogID, screenshotURL string) (*asynq.Task, error) {
	payload, err := json.Marshal(ThumbnailPayload{TimeLogID: timeLogID, ScreenshotURL: screenshotURL})
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TypeThumbnail, payload), nil
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// MakeDispatchHandler queries all users and enqueues a TypeWeeklyReport per user.
func MakeDispatchHandler(db *pgxpool.Pool, client *asynq.Client) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		rows, err := db.Query(ctx, `SELECT id, email FROM users`)
		if err != nil {
			return fmt.Errorf("query users: %w", err)
		}
		defer rows.Close()

		var count int
		for rows.Next() {
			var id, email string
			if err := rows.Scan(&id, &email); err != nil {
				continue
			}
			task, err := NewWeeklyReportTask(id, email)
			if err != nil {
				log.Printf("[jobs] build report task for %s: %v", email, err)
				continue
			}
			if _, err := client.Enqueue(task, asynq.Queue("low")); err != nil {
				log.Printf("[jobs] enqueue report for %s: %v", email, err)
			}
			count++
		}
		log.Printf("[jobs] dispatched weekly reports for %d users", count)
		return nil
	}
}

// MakeWeeklyReportHandler fetches stats and sends the HTML email.
func MakeWeeklyReportHandler(db *pgxpool.Pool) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		var p WeeklyReportPayload
		if err := json.Unmarshal(t.Payload(), &p); err != nil {
			return fmt.Errorf("unmarshal: %w", err)
		}

		data, err := report.QueryWeeklyData(ctx, db, p.UserID, p.Email)
		if err != nil {
			return fmt.Errorf("query stats: %w", err)
		}

		if len(data.Days) == 0 {
			log.Printf("[jobs] no activity for %s this week — skipping email", p.Email)
			return nil
		}

		if err := report.Send(data); err != nil {
			return fmt.Errorf("send email to %s: %w", p.Email, err)
		}

		log.Printf("[jobs] weekly report sent to %s (%.1fh total)", p.Email, data.TotalHours)
		return nil
	}
}

// MakeTimesheetAutoApproveHandler approves all submitted timesheets whose week
// ended on or before yesterday (i.e. the Sunday has passed). Runs daily at
// 00:05 UTC so any week whose Sunday just ended gets auto-approved on Monday.
func MakeTimesheetAutoApproveHandler(db *pgxpool.Pool) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		tag, err := db.Exec(ctx, `
			UPDATE timesheets
			SET status        = 'approved',
			    auto_approved = true,
			    reviewed_at   = NOW()
			WHERE status     = 'submitted'
			  AND week_start + INTERVAL '6 days' < CURRENT_DATE
		`)
		if err != nil {
			return fmt.Errorf("auto-approve timesheets: %w", err)
		}
		log.Printf("[jobs] auto-approved %d timesheets", tag.RowsAffected())
		return nil
	}
}

// MakeThumbnailHandler returns a handler that downloads the full-res PNG,
// scales it to 480px wide, re-uploads as JPEG, and stores the thumbnail URL.
func MakeThumbnailHandler(db *pgxpool.Pool, sc *spaces.Client) asynq.HandlerFunc {
	return func(ctx context.Context, t *asynq.Task) error {
		var p ThumbnailPayload
		if err := json.Unmarshal(t.Payload(), &p); err != nil {
			return fmt.Errorf("unmarshal: %w", err)
		}

		thumbURL, err := sc.GenerateThumbnail(ctx, p.ScreenshotURL)
		if err != nil {
			return fmt.Errorf("generate thumbnail for log %s: %w", p.TimeLogID, err)
		}

		_, err = db.Exec(ctx,
			`UPDATE time_logs SET thumbnail_url=$1 WHERE id=$2 AND thumbnail_url IS NULL`,
			thumbURL, p.TimeLogID,
		)
		if err != nil {
			return fmt.Errorf("update thumbnail_url for log %s: %w", p.TimeLogID, err)
		}

		log.Printf("[jobs] thumbnail generated for log %s → %s", p.TimeLogID, thumbURL)
		return nil
	}
}
