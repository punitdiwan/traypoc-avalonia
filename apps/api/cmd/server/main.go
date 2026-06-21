package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/joho/godotenv"

	"time-tracker/api/internal/db"
	"time-tracker/api/internal/handlers"
	"time-tracker/api/internal/jobs"
	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
	"time-tracker/api/internal/spaces"
)

func main() {
	// Load .env from the working directory (dev: `go run` inside apps/api) and,
	// as a fallback, from the directory holding the binary (so a standalone
	// release binary picks up a .env sitting next to it regardless of cwd).
	// godotenv never overrides variables already set, so precedence is:
	// real environment > ./.env > <exe-dir>/.env.
	_ = godotenv.Load()
	if exe, err := os.Executable(); err == nil {
		_ = godotenv.Load(filepath.Join(filepath.Dir(exe), ".env"))
	}

	ctx := context.Background()

	pool, err := db.Connect(ctx)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	if err := db.Seed(ctx, pool); err != nil {
		log.Fatalf("seed: %v", err)
	}

	// One-time fold of pre-multi-tenant data into a Default Organization.
	if err := db.BackfillDefaultOrg(ctx, pool); err != nil {
		log.Fatalf("backfill default org: %v", err)
	}

	redisAddr := os.Getenv("REDIS_URL")
	if redisAddr == "" {
		redisAddr = "localhost:6379"
	}

	jobClient := jobs.NewClient(redisAddr)
	defer jobClient.Close()

	spacesConfig := spaces.Config{
		Key:    os.Getenv("DO_SPACES_KEY"),
		Secret: os.Getenv("DO_SPACES_SECRET"),
		Bucket: os.Getenv("DO_SPACES_BUCKET"),
		Region: os.Getenv("DO_SPACES_REGION"),
	}
	var spacesClient *spaces.Client
	if spacesConfig.IsConfigured() {
		var err error
		spacesClient, err = spaces.NewClient(spacesConfig)
		if err != nil {
			log.Printf("spaces client init failed (thumbnails disabled): %v", err)
		}
	} else {
		log.Println("DO_SPACES_* not configured — server-side thumbnails disabled")
	}

	go jobs.StartWorker(redisAddr, pool, jobClient, spacesClient)
	go jobs.StartScheduler(redisAddr)

	authH := handlers.NewAuthHandler(pool)
	timeH := handlers.NewTimeLogHandler(pool, jobClient, spacesClient)
	projH := handlers.NewProjectHandler(pool)
	diaryH := handlers.NewDiaryHandler(pool)
	userH := handlers.NewUserHandler(pool)
	overviewH := handlers.NewOverviewHandler(pool)
	invoiceH := handlers.NewInvoiceHandler(pool)
	uploadH := handlers.NewUploadHandler(spacesClient)
	adminH := handlers.NewAdminHandler(pool)
	policyH := handlers.NewPolicyHandler(pool)
	appCatH := handlers.NewAppCategoryHandler(pool)
	timesheetH := handlers.NewTimesheetHandler(pool)
	previewH := handlers.NewTimesheetPreviewHandler(pool)

	r := chi.NewRouter()
	r.Use(chiMiddleware.Logger)
	r.Use(chiMiddleware.Recoverer)
	allowedOrigins := []string{
		"http://localhost:5173",  // web dashboard dev
		"http://localhost:1420",  // Tauri desktop dev (Vite)
		"tauri://localhost",      // Tauri desktop production (Windows/Linux)
		"https://tauri.localhost", // Tauri desktop production (macOS/some Linux)
	}
	if origin := os.Getenv("CORS_ORIGIN"); origin != "" {
		allowedOrigins = append(allowedOrigins, origin)
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	// Auth — public
	r.Route("/auth", func(r chi.Router) {
		r.Post("/register", authH.Register)
		r.Post("/login", authH.Login)
		r.Post("/refresh", authH.Refresh)
		r.Post("/logout", authH.Logout)
		r.Post("/forgot-password", authH.ForgotPassword)
		r.Post("/reset-password", authH.ResetPassword)
	})

	// Protected routes
	r.Group(func(r chi.Router) {
		r.Use(mw.RequireAuth)

		r.Get("/auth/me", handlers.Me(pool))
		r.Patch("/auth/me", authH.UpdateMe)
		r.Patch("/auth/password", authH.ChangePassword)

		// Live policy snapshot the desktop polls (can_track, allow_manual_time, rates).
		r.Get("/me/policy", policyH.Get)

		// Time logs — employee can CRUD their own
		r.Route("/time-logs", func(r chi.Router) {
			r.Get("/", timeH.List)
			r.Get("/ids", timeH.IDs)
			r.Post("/", timeH.Create)
			r.Delete("/", timeH.DeleteAll)
			r.Get("/{id}", timeH.Get)
			r.Patch("/{id}", timeH.Update)
			r.Delete("/{id}", timeH.Delete)
		})

		// Presigned upload URLs — desktop uploads screenshots straight to Spaces
		r.Post("/uploads/presign", uploadH.Presign)

		// Projects — anyone reads; employers create/manage
		r.Route("/projects", func(r chi.Router) {
			r.Get("/", projH.List)
			r.With(mw.RequireRole(models.RoleEmployer)).Post("/", projH.Create)
			r.With(mw.RequireRole(models.RoleEmployer)).Patch("/{id}", projH.Update)
			r.With(mw.RequireRole(models.RoleEmployer)).Get("/{id}/members", projH.ListMembers)
			r.With(mw.RequireRole(models.RoleEmployer)).Post("/{id}/members", projH.AddMember)
			r.With(mw.RequireRole(models.RoleEmployer)).Delete("/{id}/members/{userId}", projH.RemoveMember)
			r.Get("/{id}/tasks", projH.ListTasks)
			r.With(mw.RequireRole(models.RoleEmployer)).Post("/{id}/tasks", projH.CreateTask)
		})

		// Diary — employer reads any employee in their org; an employee reads only
		// their own (authorization is enforced inside the handler).
		r.Get("/diary/{userId}", diaryH.Get)

		// Team overview — employer only
		r.With(mw.RequireRole(models.RoleEmployer)).Get("/overview", overviewH.Get)

		// Billable invoice (JSON + downloadable PDF). Access is enforced inside the
		// handler: employer/god for any org employee, an employee for their own.
		r.Get("/invoice", invoiceH.Get)
		r.Get("/invoice.pdf", invoiceH.GetPDF)

		// Users — employer manages employees in their own org
		r.With(mw.RequireRole(models.RoleEmployer)).Get("/users", userH.List)
		r.With(mw.RequireRole(models.RoleEmployer)).Post("/users", userH.Invite)
		r.With(mw.RequireRole(models.RoleEmployer)).Patch("/users/{id}/can-track", userH.SetCanTrack)
		r.With(mw.RequireRole(models.RoleEmployer)).Patch("/users/{id}/allow-manual-time", userH.SetAllowManualTime)
		r.With(mw.RequireRole(models.RoleEmployer)).Patch("/users/{id}/allow-delete", userH.SetAllowDelete)
		r.With(mw.RequireRole(models.RoleEmployer)).Patch("/users/{id}/require-notes", userH.SetRequireNotes)
		r.With(mw.RequireRole(models.RoleEmployer)).Patch("/users/{id}/rate", userH.SetRate)
		r.With(mw.RequireRole(models.RoleEmployer)).Patch("/users/{id}/name", userH.SetName)
		r.With(mw.RequireRole(models.RoleEmployer)).Delete("/users/{id}/org", userH.Release)

		// App categories — employer tags app names as productive/neutral/unproductive
		r.With(mw.RequireRole(models.RoleEmployer)).Get("/app-categories", appCatH.List)
		r.With(mw.RequireRole(models.RoleEmployer)).Put("/app-categories/{appName}", appCatH.Upsert)
		r.With(mw.RequireRole(models.RoleEmployer)).Delete("/app-categories/{appName}", appCatH.Delete)

		// Timesheets — weekly approval workflow (employee submits, employer approves)
		r.Get("/timesheets", timesheetH.List)
		r.Post("/timesheets", timesheetH.Create)
		r.Post("/timesheets/{id}/submit", timesheetH.Submit)
		r.Post("/timesheets/{id}/recall", timesheetH.Recall)
		r.With(mw.RequireRole(models.RoleEmployer)).Post("/timesheets/{id}/approve", timesheetH.Approve)
		r.With(mw.RequireRole(models.RoleEmployer)).Post("/timesheets/{id}/reject", timesheetH.Reject)
		r.With(mw.RequireRole(models.RoleEmployer)).Get("/timesheet-preview", previewH.Get)

		// God super-admin — cross-organization administration
		r.With(mw.RequireGod).Get("/admin/orgs", adminH.ListOrgs)
		r.With(mw.RequireGod).Post("/admin/orgs", adminH.CreateOrg)
	})

	addr := os.Getenv("PORT")
	if addr == "" {
		addr = "8080"
	}

	srv := &http.Server{Addr: ":" + addr, Handler: r}

	go func() {
		log.Printf("listening on :%s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit

	log.Println("shutting down...")
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("stopped")
}
