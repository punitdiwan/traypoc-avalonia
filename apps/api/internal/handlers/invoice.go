package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
)

type InvoiceHandler struct {
	db *pgxpool.Pool
}

func NewInvoiceHandler(db *pgxpool.Pool) *InvoiceHandler {
	return &InvoiceHandler{db: db}
}

type invoiceLine struct {
	ProjectID   *uuid.UUID `json:"project_id"`
	Name        string     `json:"name"`
	Seconds     int        `json:"seconds"`
	RateCents   int        `json:"rate_cents"`
	AmountCents int64      `json:"amount_cents"`
}

// Get builds a billable invoice/timesheet for one employee over a date range,
// with line items grouped by project. Employer-only.
// Query: user_id (required), from & to (YYYY-MM-DD, required).
func (h *InvoiceHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("user_id")
	if userID == "" {
		http.Error(w, "user_id required", http.StatusBadRequest)
		return
	}
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")
	from, err1 := time.Parse("2006-01-02", fromStr)
	to, err2 := time.Parse("2006-01-02", toStr)
	if err1 != nil || err2 != nil {
		http.Error(w, "from and to required (YYYY-MM-DD)", http.StatusBadRequest)
		return
	}
	if to.Before(from) {
		from, to = to, from
	}

	// The employee must be in the caller's organization (god may invoice anyone).
	var email, fullName string
	var empErr error
	if mw.IsGod(r) {
		empErr = h.db.QueryRow(r.Context(),
			`SELECT email, full_name FROM users WHERE id=$1 AND role='employee'`, userID,
		).Scan(&email, &fullName)
	} else {
		empErr = h.db.QueryRow(r.Context(),
			`SELECT email, full_name FROM users WHERE id=$1 AND role='employee' AND org_id=$2`,
			userID, mw.OrgID(r),
		).Scan(&email, &fullName)
	}
	if empErr != nil {
		http.Error(w, "employee not found", http.StatusNotFound)
		return
	}

	// Restrict line items to the caller's org as defence-in-depth.
	args := []any{userID, from.Format("2006-01-02"), to.Format("2006-01-02")}
	tOrg := ""
	if !mw.IsGod(r) {
		args = append(args, mw.OrgID(r))
		tOrg = " AND t.org_id=$4"
	}

	// One line per project (NULL project rolls up into "Unassigned"). Rate is
	// constant within a group, so MAX() just extracts it.
	rows, err := h.db.Query(r.Context(),
		`SELECT p.id, p.name,
		        SUM(t.duration_seconds)::int AS seconds,
		        MAX(`+rateExpr+`)::int AS rate_cents
		 FROM time_logs t
		 JOIN users u ON u.id = t.user_id
		 LEFT JOIN projects p ON p.id = t.project_id
		 WHERE t.user_id=$1 AND t.started_at::date BETWEEN $2::date AND $3::date`+tOrg+`
		 GROUP BY p.id, p.name
		 ORDER BY seconds DESC`,
		args...,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	lines := make([]invoiceLine, 0)
	var totalSeconds int
	var totalCents int64
	for rows.Next() {
		var l invoiceLine
		var name *string
		if err := rows.Scan(&l.ProjectID, &name, &l.Seconds, &l.RateCents); err != nil {
			continue
		}
		if name != nil {
			l.Name = *name
		} else {
			l.Name = "Unassigned"
		}
		// Round to nearest cent on the hours×rate product.
		l.AmountCents = (int64(l.Seconds)*int64(l.RateCents) + 1800) / 3600
		lines = append(lines, l)
		totalSeconds += l.Seconds
		totalCents += l.AmountCents
	}

	resp := map[string]any{
		"user_id":       userID,
		"email":         email,
		"full_name":     fullName,
		"from":          from.Format("2006-01-02"),
		"to":            to.Format("2006-01-02"),
		"currency":      currencyCode(),
		"line_items":    lines,
		"total_seconds": totalSeconds,
		"total_cents":   totalCents,
		"generated_at":  time.Now().UTC(),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
