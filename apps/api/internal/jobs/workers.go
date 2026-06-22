package jobs

import (
	"log"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/spaces"
)

func NewClient(redisAddr string) *asynq.Client {
	return asynq.NewClient(asynq.RedisClientOpt{Addr: redisAddr})
}

// StartWorker runs the asynq worker server (blocking — call in a goroutine).
// sc may be nil if DO Spaces is not configured; thumbnail jobs will be skipped.
func StartWorker(redisAddr string, db *pgxpool.Pool, client *asynq.Client, sc *spaces.Client) {
	srv := asynq.NewServer(
		asynq.RedisClientOpt{Addr: redisAddr},
		asynq.Config{
			Concurrency: 5,
			Queues: map[string]int{
				"critical": 6,
				"default":  3,
				"low":      1,
			},
		},
	)

	mux := asynq.NewServeMux()
	mux.HandleFunc(TypeWeeklyReportDispatch, MakeDispatchHandler(db, client))
	mux.HandleFunc(TypeWeeklyReport, MakeWeeklyReportHandler(db))
	mux.HandleFunc(TypeTimesheetAutoApprove, MakeTimesheetAutoApproveHandler(db))
	if sc != nil {
		mux.HandleFunc(TypeThumbnail, MakeThumbnailHandler(db, sc))
	}

	if err := srv.Run(mux); err != nil {
		log.Fatalf("asynq worker: %v", err)
	}
}

// StartScheduler registers cron jobs and runs the asynq scheduler (blocking — call in a goroutine).
// Cron: every Monday at 09:00 UTC dispatch weekly reports.
func StartScheduler(redisAddr string) {
	scheduler := asynq.NewScheduler(
		asynq.RedisClientOpt{Addr: redisAddr},
		&asynq.SchedulerOpts{},
	)

	dispatchTask := asynq.NewTask(TypeWeeklyReportDispatch, nil)
	if _, err := scheduler.Register("0 9 * * MON", dispatchTask, asynq.Queue("default")); err != nil {
		log.Fatalf("register weekly report cron: %v", err)
	}

	autoApproveTask := asynq.NewTask(TypeTimesheetAutoApprove, nil)
	if _, err := scheduler.Register("5 0 * * *", autoApproveTask, asynq.Queue("default")); err != nil {
		log.Fatalf("register timesheet auto-approve cron: %v", err)
	}

	log.Println("[scheduler] weekly report cron registered (Mon 09:00 UTC)")
	log.Println("[scheduler] timesheet auto-approve cron registered (daily 00:05 UTC)")

	if err := scheduler.Run(); err != nil {
		log.Fatalf("asynq scheduler: %v", err)
	}
}
