package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
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

// invoiceData is the fully computed invoice, shared by the JSON and PDF renderers.
type invoiceData struct {
	UserID       string
	Email        string
	FullName     string
	From         string
	To           string
	Currency     string
	Lines        []invoiceLine
	TotalSeconds int
	TotalCents   int64
	GeneratedAt  time.Time
	// Locked is true when TotalCents was taken from an approved timesheet's
	// frozen total_billable_cents rather than recomputed from current logs/rates.
	Locked bool
}

// build resolves access, validates the date range, and computes the invoice.
// On failure it returns an HTTP status code and an error describing the problem.
//
// When lockToTimesheet is true, build looks up an approved timesheet whose
// week_start equals the `from` date and, if found, uses its frozen
// total_billable_cents as the authoritative Total due (rather than recomputing
// from current logs/rates). The per-project line items always reflect logs.
//
// Access rules:
//   - god: any employee
//   - employer: an employee in their own organization
//   - employee: only themselves
func (h *InvoiceHandler) build(r *http.Request, userID, fromStr, toStr string, lockToTimesheet bool) (*invoiceData, int, error) {
	if userID == "" {
		return nil, http.StatusBadRequest, errors.New("user_id required")
	}
	from, err1 := time.Parse("2006-01-02", fromStr)
	to, err2 := time.Parse("2006-01-02", toStr)
	if err1 != nil || err2 != nil {
		return nil, http.StatusBadRequest, errors.New("from and to required (YYYY-MM-DD)")
	}
	if to.Before(from) {
		from, to = to, from
	}

	ctx := r.Context()

	// ── access control + employee lookup ─────────────────────────────────────
	var email, fullName string
	var lookupErr error
	switch {
	case mw.IsGod(r):
		lookupErr = h.db.QueryRow(ctx,
			`SELECT email, full_name FROM users WHERE id=$1 AND role='employee'`, userID,
		).Scan(&email, &fullName)
	case mw.Role(r) == models.RoleEmployer:
		lookupErr = h.db.QueryRow(ctx,
			`SELECT email, full_name FROM users WHERE id=$1 AND role='employee' AND org_id=$2`,
			userID, mw.OrgID(r),
		).Scan(&email, &fullName)
	default: // employee — own invoice only
		if userID != mw.UserID(r) {
			return nil, http.StatusForbidden, errors.New("you can only view your own invoice")
		}
		lookupErr = h.db.QueryRow(ctx,
			`SELECT email, full_name FROM users WHERE id=$1`, userID,
		).Scan(&email, &fullName)
	}
	if lookupErr != nil {
		return nil, http.StatusNotFound, errors.New("employee not found")
	}

	// ── line items grouped by project ────────────────────────────────────────
	// Restrict to the caller's org as defence-in-depth (god is cross-org).
	args := []any{userID, from.Format("2006-01-02"), to.Format("2006-01-02")}
	tOrg := ""
	if !mw.IsGod(r) {
		args = append(args, mw.OrgID(r))
		tOrg = " AND t.org_id=$4"
	}

	rows, err := h.db.Query(ctx,
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
		return nil, http.StatusInternalServerError, errors.New("query error")
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
		l.AmountCents = (int64(l.Seconds)*int64(l.RateCents) + 1800) / 3600
		lines = append(lines, l)
		totalSeconds += l.Seconds
		totalCents += l.AmountCents
	}

	d := &invoiceData{
		UserID:       userID,
		Email:        email,
		FullName:     fullName,
		From:         from.Format("2006-01-02"),
		To:           to.Format("2006-01-02"),
		Currency:     currencyCode(),
		Lines:        lines,
		TotalSeconds: totalSeconds,
		TotalCents:   totalCents,
		GeneratedAt:  time.Now().UTC(),
	}

	// Prefer the frozen amount from an approved timesheet for this exact week, so
	// the paid invoice always matches what was locked at approval — even if rates
	// or logs changed afterwards. Falls back to the computed total when there's no
	// approved timesheet (e.g. a stale link or an ad-hoc Reports date range).
	if lockToTimesheet {
		var locked int64
		err := h.db.QueryRow(ctx, `
			SELECT total_billable_cents FROM timesheets
			WHERE user_id = $1 AND week_start = $2::date AND status = 'approved'
		`, userID, d.From).Scan(&locked)
		if err == nil {
			d.TotalCents = locked
			d.Locked = true
		}
	}

	return d, http.StatusOK, nil
}

// Get builds a billable invoice/timesheet for one employee over a date range as
// JSON, with line items grouped by project.
// Query: user_id (required), from & to (YYYY-MM-DD, required).
func (h *InvoiceHandler) Get(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	d, status, err := h.build(r, q.Get("user_id"), q.Get("from"), q.Get("to"), q.Get("approved") == "1")
	if err != nil {
		http.Error(w, err.Error(), status)
		return
	}

	resp := map[string]any{
		"user_id":       d.UserID,
		"email":         d.Email,
		"full_name":     d.FullName,
		"from":          d.From,
		"to":            d.To,
		"currency":      d.Currency,
		"line_items":    d.Lines,
		"total_seconds": d.TotalSeconds,
		"total_cents":   d.TotalCents,
		"locked":        d.Locked,
		"generated_at":  d.GeneratedAt,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// GetPDF renders the same invoice as a downloadable PDF.
// Query: user_id, from, to (all required), plus optional approved=1 to stamp PAID.
func (h *InvoiceHandler) GetPDF(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	paid := q.Get("approved") == "1"
	d, status, err := h.build(r, q.Get("user_id"), q.Get("from"), q.Get("to"), paid)
	if err != nil {
		http.Error(w, err.Error(), status)
		return
	}

	pdfBytes, err := renderInvoicePDF(d, paid)
	if err != nil {
		http.Error(w, "failed to render PDF", http.StatusInternalServerError)
		return
	}

	filename := "invoice-" + d.From + "-to-" + d.To + ".pdf"
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(pdfBytes)))
	w.Write(pdfBytes)
}
