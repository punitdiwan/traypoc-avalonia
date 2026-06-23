package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
)

type TimesheetHandler struct {
	db *pgxpool.Pool
}

func NewTimesheetHandler(db *pgxpool.Pool) *TimesheetHandler {
	return &TimesheetHandler{db: db}
}

// normalizeToMonday returns the Monday of the ISO week containing t (UTC).
func normalizeToMonday(t time.Time) time.Time {
	t = t.UTC().Truncate(24 * time.Hour)
	wd := t.Weekday()
	if wd == time.Sunday {
		wd = 7
	}
	return t.AddDate(0, 0, -int(wd-time.Monday))
}

const timesheetSelectCols = `
	ts.id, ts.user_id, u.email, COALESCE(u.full_name,'') AS full_name,
	ts.org_id,
	ts.week_start::text,
	(ts.week_start + INTERVAL '6 days')::date::text AS week_end,
	ts.status, ts.employee_note, ts.employer_note,
	ts.submitted_at, ts.reviewed_at, ts.reviewed_by,
	ts.auto_approved, ts.created_at,
	COALESCE((
	    SELECT SUM(duration_seconds)::int FROM time_logs tl
	    WHERE tl.user_id = ts.user_id
	      AND tl.started_at::date >= ts.week_start
	      AND tl.started_at::date <= ts.week_start + INTERVAL '6 days'
	), 0) AS total_seconds,
	ts.total_billable_cents
`

func scanTimesheet(row interface{ Scan(...any) error }) (*models.Timesheet, error) {
	var ts models.Timesheet
	err := row.Scan(
		&ts.ID, &ts.UserID, &ts.UserEmail, &ts.UserFullName,
		&ts.OrgID, &ts.WeekStart, &ts.WeekEnd,
		&ts.Status, &ts.EmployeeNote, &ts.EmployerNote,
		&ts.SubmittedAt, &ts.ReviewedAt, &ts.ReviewedBy,
		&ts.AutoApproved, &ts.CreatedAt, &ts.TotalSeconds, &ts.TotalBillableCents,
	)
	return &ts, err
}

// List returns timesheets scoped to the caller:
//   - employee: their own (last 52 weeks)
//   - employer: all in their org, pending (submitted) first
func (h *TimesheetHandler) List(w http.ResponseWriter, r *http.Request) {
	var (
		query string
		args  []any
	)

	if mw.Role(r) == models.RoleEmployee {
		query = `SELECT ` + timesheetSelectCols + `
		FROM timesheets ts JOIN users u ON u.id = ts.user_id
		WHERE ts.user_id = $1
		ORDER BY ts.week_start DESC
		LIMIT 52`
		args = []any{mw.UserID(r)}
	} else {
		query = `SELECT ` + timesheetSelectCols + `
		FROM timesheets ts JOIN users u ON u.id = ts.user_id
		WHERE ts.org_id = $1
		ORDER BY (ts.status = 'submitted') DESC,
		         ts.submitted_at DESC NULLS LAST,
		         ts.week_start DESC
		LIMIT 200`
		args = []any{mw.OrgID(r)}
	}

	rows, err := h.db.Query(r.Context(), query, args...)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var result []models.Timesheet
	for rows.Next() {
		ts, err := scanTimesheet(rows)
		if err != nil {
			continue
		}
		result = append(result, *ts)
	}
	if result == nil {
		result = []models.Timesheet{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// Create gets or creates a draft timesheet for a given week.
// Body: {"week_start": "YYYY-MM-DD", "employee_note": "..."}
// The week_start is normalized to Monday. Returns 201 when created, 200 when
// the sheet already exists (idempotent — safe to call on every page load).
func (h *TimesheetHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)
	orgID := mw.OrgID(r)
	if orgID == "" {
		http.Error(w, "your account is not part of an organization", http.StatusForbidden)
		return
	}

	var req struct {
		WeekStart    string  `json:"week_start"`
		EmployeeNote *string `json:"employee_note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	var weekStart time.Time
	if req.WeekStart == "" {
		weekStart = normalizeToMonday(time.Now())
	} else {
		t, err := time.Parse("2006-01-02", req.WeekStart)
		if err != nil {
			http.Error(w, "week_start must be YYYY-MM-DD", http.StatusBadRequest)
			return
		}
		weekStart = normalizeToMonday(t)
	}
	weekStartStr := weekStart.Format("2006-01-02")

	// Upsert: create if absent, update note if present.
	// If the sheet was previously rejected, reset it back to draft so the
	// employee can resubmit — clears the employer review fields.
	var id uuid.UUID
	err := h.db.QueryRow(r.Context(), `
		INSERT INTO timesheets (user_id, org_id, week_start, employee_note)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id, week_start) DO UPDATE
		  SET employee_note = COALESCE(EXCLUDED.employee_note, timesheets.employee_note),
		      status        = CASE WHEN timesheets.status = 'rejected' THEN 'draft' ELSE timesheets.status END,
		      reviewed_at   = CASE WHEN timesheets.status = 'rejected' THEN NULL ELSE timesheets.reviewed_at END,
		      reviewed_by   = CASE WHEN timesheets.status = 'rejected' THEN NULL ELSE timesheets.reviewed_by END,
		      employer_note = CASE WHEN timesheets.status = 'rejected' THEN NULL ELSE timesheets.employer_note END
		RETURNING id
	`, userID, orgID, weekStartStr, req.EmployeeNote).Scan(&id)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	ts, err := scanTimesheet(h.db.QueryRow(r.Context(),
		`SELECT `+timesheetSelectCols+`
		 FROM timesheets ts JOIN users u ON u.id = ts.user_id
		 WHERE ts.id = $1`, id))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(ts)
}

// Submit transitions the timesheet from draft → submitted.
func (h *TimesheetHandler) Submit(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := mw.UserID(r)

	var req struct {
		EmployeeNote *string `json:"employee_note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	tag, err := h.db.Exec(r.Context(), `
		UPDATE timesheets
		SET status = 'submitted',
		    submitted_at = NOW(),
		    employee_note = COALESCE($3, employee_note)
		WHERE id = $1 AND user_id = $2 AND status = 'draft'
	`, id, userID, req.EmployeeNote)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "timesheet not found or not in draft status", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Recall transitions the timesheet from submitted → draft (before review only).
func (h *TimesheetHandler) Recall(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := mw.UserID(r)

	tag, err := h.db.Exec(r.Context(), `
		UPDATE timesheets
		SET status = 'draft', submitted_at = NULL
		WHERE id = $1 AND user_id = $2 AND status = 'submitted' AND reviewed_at IS NULL
	`, id, userID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "timesheet not found, not submitted, or already reviewed", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Approve transitions a submitted timesheet to approved (employer/god only).
// Computes and locks total_billable_cents at the moment of approval so the
// amount is immutable even if rates or logs change afterwards.
// Optional body: {"employer_note": "..."}
func (h *TimesheetHandler) Approve(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	reviewerID := mw.UserID(r)
	orgID := mw.OrgID(r)

	var req struct {
		EmployerNote *string `json:"employer_note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	// Step 1: fetch timesheet to get user_id and week_start (validates org + status).
	fetchQ := `SELECT user_id::text, week_start::text FROM timesheets WHERE id = $1 AND status = 'submitted'`
	fetchArgs := []any{id}
	if !mw.IsGod(r) {
		fetchQ += ` AND org_id = $2`
		fetchArgs = append(fetchArgs, orgID)
	}
	var userID, weekStart string
	if err := h.db.QueryRow(r.Context(), fetchQ, fetchArgs...).Scan(&userID, &weekStart); err != nil {
		http.Error(w, "timesheet not found or not submitted", http.StatusNotFound)
		return
	}

	// Step 2: compute total billable for this week (project rate > user rate > 0).
	var totalBillable int64
	_ = h.db.QueryRow(r.Context(), `
		SELECT COALESCE((
		    SELECT (SUM(t.duration_seconds::bigint * `+rateExpr+`) / 3600)::bigint
		    FROM time_logs t
		    JOIN users u ON u.id = t.user_id
		    LEFT JOIN projects p ON p.id = t.project_id
		    WHERE t.user_id = $1
		      AND t.started_at::date >= $2::date
		      AND t.started_at::date <= $2::date + INTERVAL '6 days'
		), 0)
	`, userID, weekStart).Scan(&totalBillable)

	// Step 3: approve and store the locked billable amount.
	updQ := `
		UPDATE timesheets
		SET status = 'approved', reviewed_at = NOW(), reviewed_by = $2,
		    employer_note = $3, total_billable_cents = $4
		WHERE id = $1 AND status = 'submitted'`
	updArgs := []any{id, reviewerID, req.EmployerNote, totalBillable}
	if !mw.IsGod(r) {
		updQ += ` AND org_id = $5`
		updArgs = append(updArgs, orgID)
	}
	tag, err := h.db.Exec(r.Context(), updQ, updArgs...)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "timesheet not found or already reviewed", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Reject transitions a submitted timesheet to rejected (employer/god only).
// Body: {"employer_note": "..."}
func (h *TimesheetHandler) Reject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	reviewerID := mw.UserID(r)

	var req struct {
		EmployerNote *string `json:"employer_note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	var where string
	var args []any
	if mw.IsGod(r) {
		where = `id = $1 AND status = 'submitted'`
		args = []any{id, reviewerID, req.EmployerNote}
	} else {
		where = `id = $1 AND org_id = $4 AND status = 'submitted'`
		args = []any{id, reviewerID, req.EmployerNote, mw.OrgID(r)}
	}

	tag, err := h.db.Exec(r.Context(), `
		UPDATE timesheets
		SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $2, employer_note = $3
		WHERE `+where, args...)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "timesheet not found or not submitted", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
