package models

import (
	"time"

	"github.com/google/uuid"
)

type Role string

const (
	RoleEmployee Role = "employee"
	RoleEmployer Role = "employer"
	// RoleGod is the unrestricted super-admin: no organization, sees and manages
	// everything across all tenants.
	RoleGod Role = "god"
)

type User struct {
	ID              uuid.UUID `json:"id"`
	Email           string    `json:"email"`
	FullName        string    `json:"full_name"`
	PasswordHash    string    `json:"-"`
	Role            Role      `json:"role"`
	CanTrack        bool      `json:"can_track"`
	AllowManualTime bool      `json:"allow_manual_time"`
	AllowDelete     bool      `json:"allow_delete"`
	RequireNotes    bool      `json:"require_notes"`
	HourlyRateCents int       `json:"hourly_rate_cents"`
	// Break policy (employer-controlled). breaks_per_day / break_daily_minutes of
	// 0 mean unlimited.
	BreaksEnabled        bool       `json:"breaks_enabled"`
	BreakDurationMinutes int        `json:"break_duration_minutes"`
	BreaksPerDay         int        `json:"breaks_per_day"`
	BreakDailyMinutes    int        `json:"break_daily_minutes"`
	OrgID                *uuid.UUID `json:"org_id"`
	OrgName              string     `json:"org_name,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
}

type Organization struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	OwnerID   uuid.UUID `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}

type Project struct {
	ID              uuid.UUID `json:"id"`
	Name            string    `json:"name"`
	OwnerID         uuid.UUID `json:"owner_id"`
	HourlyRateCents int       `json:"hourly_rate_cents"`
	CreatedAt       time.Time `json:"created_at"`
}

type Task struct {
	ID        uuid.UUID `json:"id"`
	ProjectID uuid.UUID `json:"project_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type TimeLog struct {
	ID              uuid.UUID  `json:"id"`
	UserID          uuid.UUID  `json:"user_id"`
	ProjectID       *uuid.UUID `json:"project_id"`
	TaskID          *uuid.UUID `json:"task_id"`
	StartedAt       time.Time  `json:"started_at"`
	EndedAt         time.Time  `json:"ended_at"`
	DurationSeconds int        `json:"duration_seconds"`
	ActivityPercent int        `json:"activity_percent"`
	ScreenshotURL   *string    `json:"screenshot_url"`
	ThumbnailURL    *string    `json:"thumbnail_url"`
	WindowTitle     *string    `json:"window_title"`
	AppName         *string    `json:"app_name"`
	CreatedAt       time.Time  `json:"created_at"`
}

// DiaryEntry groups time logs by hour for the employer diary view.
type DiaryEntry struct {
	Hour     int       `json:"hour"`
	TimeLogs []TimeLog `json:"time_logs"`
}

// AppSeen is a row in the app-categories view: an app name seen in the org's time
// logs, with the total hours logged under it and the employer's category tag.
type AppSeen struct {
	AppName      string  `json:"app_name"`
	TotalSeconds int     `json:"total_seconds"`
	Category     *string `json:"category"`
}

// Timesheet is a weekly period an employee submits for employer approval.
// WeekStart is always the ISO Monday of the week (YYYY-MM-DD).
// Auto-approves on Monday if the employer hasn't acted by the Sunday of that week.
type Timesheet struct {
	ID                 uuid.UUID  `json:"id"`
	UserID             uuid.UUID  `json:"user_id"`
	UserEmail          string     `json:"user_email,omitempty"`
	UserFullName       string     `json:"user_full_name,omitempty"`
	OrgID              uuid.UUID  `json:"org_id"`
	WeekStart          string     `json:"week_start"`
	WeekEnd            string     `json:"week_end"`
	Status             string     `json:"status"`
	EmployeeNote       *string    `json:"employee_note"`
	EmployerNote       *string    `json:"employer_note"`
	SubmittedAt        *time.Time `json:"submitted_at"`
	ReviewedAt         *time.Time `json:"reviewed_at"`
	ReviewedBy         *uuid.UUID `json:"reviewed_by"`
	AutoApproved       bool       `json:"auto_approved"`
	CreatedAt          time.Time  `json:"created_at"`
	TotalSeconds       int        `json:"total_seconds"`
	TotalBillableCents int64      `json:"total_billable_cents"`
}

// Call is a voice call between an employer and an employee in an org.
// Status: ringing → answered → ended | missed | rejected | failed.
type Call struct {
	ID               uuid.UUID  `json:"id"`
	OrgID            uuid.UUID  `json:"org_id"`
	CallerID         uuid.UUID  `json:"caller_id"`
	CalleeID         uuid.UUID  `json:"callee_id"`
	CallerName       string     `json:"caller_name,omitempty"`
	CalleeName       string     `json:"callee_name,omitempty"`
	Status           string     `json:"status"`
	StartedAt        time.Time  `json:"started_at"`
	AnsweredAt       *time.Time `json:"answered_at"`
	EndedAt          *time.Time `json:"ended_at"`
	DurationSeconds  int        `json:"duration_seconds"`
	RecordingURL     *string    `json:"recording_url,omitempty"`
}

// CallRecording is the server-side recording produced for a call.
type CallRecording struct {
	ID              uuid.UUID `json:"id"`
	CallID          uuid.UUID `json:"call_id"`
	StorageURL      string    `json:"storage_url"`
	Format          string    `json:"format"`
	SizeBytes       int64     `json:"size_bytes"`
	DurationSeconds int       `json:"duration_seconds"`
	CreatedAt       time.Time `json:"created_at"`
}

// Message is one text chat message between two users in an org.
type Message struct {
	ID          uuid.UUID  `json:"id"`
	OrgID       uuid.UUID  `json:"org_id"`
	SenderID    uuid.UUID  `json:"sender_id"`
	RecipientID uuid.UUID  `json:"recipient_id"`
	Body        string     `json:"body"`
	CreatedAt   time.Time  `json:"created_at"`
	ReadAt      *time.Time `json:"read_at"`
}

// ClaimDocument is one supporting file attached to a claim (PDF/PNG/JPG), stored
// in Spaces and referenced by its public URL.
type ClaimDocument struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	ContentType string `json:"content_type"`
}

// Claim is an employee's reimbursement claim awaiting employer approval. Once
// approved it is billed on invoices whose date range covers CreatedAt.
type Claim struct {
	ID           uuid.UUID       `json:"id"`
	UserID       uuid.UUID       `json:"user_id"`
	UserEmail    string          `json:"user_email,omitempty"`
	UserFullName string          `json:"user_full_name,omitempty"`
	OrgID        uuid.UUID       `json:"org_id"`
	Title        string          `json:"title"`
	Description  *string         `json:"description"`
	AmountCents  int64           `json:"amount_cents"`
	Status       string          `json:"status"`
	Documents    []ClaimDocument `json:"documents"`
	EmployerNote *string         `json:"employer_note"`
	ReviewedAt   *time.Time      `json:"reviewed_at"`
	ReviewedBy   *uuid.UUID      `json:"reviewed_by"`
	CreatedAt    time.Time       `json:"created_at"`
}
