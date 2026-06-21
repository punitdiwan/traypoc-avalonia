package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
)

type TimesheetPreviewHandler struct {
	db *pgxpool.Pool
}

func NewTimesheetPreviewHandler(db *pgxpool.Pool) *TimesheetPreviewHandler {
	return &TimesheetPreviewHandler{db: db}
}

// Get returns a detailed breakdown for a single employee's week:
//   - daily_hours: seconds worked per day (Mon–Sun, missing days omitted)
//   - projects: hours + billable per project
//   - apps: top apps used with category tag
//   - total_seconds, total_billable_cents, currency
//
// Query params: user_id (required), from (YYYY-MM-DD), to (YYYY-MM-DD)
// Employer-only.
func (h *TimesheetPreviewHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("user_id")
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")
	if userID == "" || fromStr == "" || toStr == "" {
		http.Error(w, "user_id, from, and to are required", http.StatusBadRequest)
		return
	}
	if _, err := time.Parse("2006-01-02", fromStr); err != nil {
		http.Error(w, "from must be YYYY-MM-DD", http.StatusBadRequest)
		return
	}
	if _, err := time.Parse("2006-01-02", toStr); err != nil {
		http.Error(w, "to must be YYYY-MM-DD", http.StatusBadRequest)
		return
	}

	orgID := mw.OrgID(r)

	// ── daily totals ─────────────────────────────────────────────────────────
	type dailyRow struct {
		Date    string `json:"date"`
		Seconds int    `json:"seconds"`
	}
	dRows, err := h.db.Query(r.Context(), `
		SELECT started_at::date::text, SUM(duration_seconds)::int
		FROM time_logs
		WHERE user_id = $1
		  AND started_at::date >= $2::date
		  AND started_at::date <= $3::date
		GROUP BY started_at::date
		ORDER BY started_at::date
	`, userID, fromStr, toStr)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer dRows.Close()
	daily := make([]dailyRow, 0)
	for dRows.Next() {
		var d dailyRow
		if err := dRows.Scan(&d.Date, &d.Seconds); err == nil {
			daily = append(daily, d)
		}
	}

	// ── project breakdown ─────────────────────────────────────────────────────
	type projectRow struct {
		ProjectID    *string `json:"project_id"`
		Name         string  `json:"name"`
		Seconds      int     `json:"seconds"`
		BillableCents int64  `json:"billable_cents"`
	}
	pRows, err := h.db.Query(r.Context(), `
		SELECT p.id::text,
		       COALESCE(p.name, 'Unassigned'),
		       SUM(t.duration_seconds)::int,
		       (SUM(t.duration_seconds::bigint * `+rateExpr+`) / 3600)::bigint
		FROM time_logs t
		JOIN users u ON u.id = t.user_id
		LEFT JOIN projects p ON p.id = t.project_id
		WHERE t.user_id = $1
		  AND t.started_at::date >= $2::date
		  AND t.started_at::date <= $3::date
		GROUP BY p.id, p.name, u.hourly_rate_cents
		ORDER BY SUM(t.duration_seconds) DESC
	`, userID, fromStr, toStr)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer pRows.Close()
	projects := make([]projectRow, 0)
	var totalSeconds int
	var totalBillable int64
	for pRows.Next() {
		var p projectRow
		if err := pRows.Scan(&p.ProjectID, &p.Name, &p.Seconds, &p.BillableCents); err == nil {
			projects = append(projects, p)
			totalSeconds += p.Seconds
			totalBillable += p.BillableCents
		}
	}

	// ── app usage ─────────────────────────────────────────────────────────────
	type appRow struct {
		AppName  string  `json:"app_name"`
		Seconds  int     `json:"seconds"`
		Category *string `json:"category"`
	}
	aRows, err := h.db.Query(r.Context(), `
		SELECT t.app_name, SUM(t.duration_seconds)::int, ac.category
		FROM time_logs t
		LEFT JOIN app_categories ac ON ac.org_id = $4 AND ac.app_name = t.app_name
		WHERE t.user_id = $1
		  AND t.started_at::date >= $2::date
		  AND t.started_at::date <= $3::date
		  AND t.app_name IS NOT NULL
		  AND t.app_name <> ''
		GROUP BY t.app_name, ac.category
		ORDER BY SUM(t.duration_seconds) DESC
		LIMIT 20
	`, userID, fromStr, toStr, orgID)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer aRows.Close()
	apps := make([]appRow, 0)
	for aRows.Next() {
		var a appRow
		if err := aRows.Scan(&a.AppName, &a.Seconds, &a.Category); err == nil {
			apps = append(apps, a)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"user_id":              userID,
		"from":                 fromStr,
		"to":                   toStr,
		"daily_hours":          daily,
		"projects":             projects,
		"apps":                 apps,
		"total_seconds":        totalSeconds,
		"total_billable_cents": totalBillable,
		"currency":             currencyCode(),
	})
}
