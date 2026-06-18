package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
)

type OverviewHandler struct {
	db *pgxpool.Pool
}

func NewOverviewHandler(db *pgxpool.Pool) *OverviewHandler {
	return &OverviewHandler{db: db}
}

// rateExpr resolves the billable rate for a time-log row: the project's rate
// when set (> 0), otherwise the employee's default rate. Billable cents for a
// group is SUM(seconds * rate) / 3600.
const rateExpr = `COALESCE(NULLIF(p.hourly_rate_cents,0), u.hourly_rate_cents, 0)`
const billableExpr = `(SUM(t.duration_seconds::bigint * ` + rateExpr + `) / 3600)::bigint`

type dailyPoint struct {
	Date          string `json:"date"`
	TotalSeconds  int    `json:"total_seconds"`
	AvgActivity   int    `json:"avg_activity"`
	ActiveUsers   int    `json:"active_users"`
	BillableCents int64  `json:"billable_cents"`
}

type employeeSummary struct {
	UserID          uuid.UUID  `json:"user_id"`
	Email           string     `json:"email"`
	TotalSeconds    int        `json:"total_seconds"`
	AvgActivity     int        `json:"avg_activity"`
	CanTrack        bool       `json:"can_track"`
	HourlyRateCents int        `json:"hourly_rate_cents"`
	BillableCents   int64      `json:"billable_cents"`
	LastActive      *time.Time `json:"last_active"`
}

type projectSummary struct {
	ProjectID     *uuid.UUID `json:"project_id"`
	Name          string     `json:"name"`
	TotalSeconds  int        `json:"total_seconds"`
	AvgActivity   int        `json:"avg_activity"`
	BillableCents int64      `json:"billable_cents"`
}

// resolveRange derives the [from, to] date window from query params. A from/to
// pair (YYYY-MM-DD) takes precedence; otherwise it's the last `days` days
// (default 7, max 90) ending today (UTC).
func resolveRange(r *http.Request) (from, to time.Time, days int, err error) {
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")
	if fromStr != "" && toStr != "" {
		from, err = time.Parse("2006-01-02", fromStr)
		if err != nil {
			return
		}
		to, err = time.Parse("2006-01-02", toStr)
		if err != nil {
			return
		}
		if to.Before(from) {
			from, to = to, from
		}
		days = int(to.Sub(from).Hours()/24) + 1
		if days > 366 {
			days = 366
		}
		return
	}

	days = 7
	if d := r.URL.Query().Get("days"); d != "" {
		if n, e := strconv.Atoi(d); e == nil && n > 0 {
			days = n
		}
	}
	if days > 90 {
		days = 90
	}
	to = time.Now().UTC().Truncate(24 * time.Hour)
	from = to.AddDate(0, 0, -(days - 1))
	return
}

// Get returns a team-wide overview over a date window: a zero-filled daily
// time-series, per-employee totals, per-project totals, and headline totals —
// all including billable amounts (cents). Employer-only.
func (h *OverviewHandler) Get(w http.ResponseWriter, r *http.Request) {
	from, to, days, err := resolveRange(r)
	if err != nil {
		http.Error(w, "invalid date (use YYYY-MM-DD)", http.StatusBadRequest)
		return
	}
	fromS, toS := from.Format("2006-01-02"), to.Format("2006-01-02")

	// Restrict every aggregate to the caller's organization (god sees all orgs).
	args := []any{fromS, toS}
	tOrg, uOrg := "", ""
	if !mw.IsGod(r) {
		args = append(args, mw.OrgID(r))
		tOrg = " AND t.org_id=$3"
		uOrg = " AND u.org_id=$3"
	}

	// Daily aggregates keyed by date string.
	dailyMap := make(map[string]dailyPoint)
	rows, err := h.db.Query(r.Context(),
		`SELECT t.started_at::date AS day,
		        SUM(t.duration_seconds)::int,
		        COALESCE(AVG(t.activity_percent),0)::int,
		        COUNT(DISTINCT t.user_id),
		        `+billableExpr+`
		 FROM time_logs t
		 JOIN users u ON u.id = t.user_id
		 LEFT JOIN projects p ON p.id = t.project_id
		 WHERE t.started_at::date BETWEEN $1::date AND $2::date`+tOrg+`
		 GROUP BY day`,
		args...,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	for rows.Next() {
		var day time.Time
		var p dailyPoint
		if err := rows.Scan(&day, &p.TotalSeconds, &p.AvgActivity, &p.ActiveUsers, &p.BillableCents); err != nil {
			continue
		}
		p.Date = day.Format("2006-01-02")
		dailyMap[p.Date] = p
	}
	rows.Close()

	// Zero-fill every day in the window so the chart has a continuous series.
	daily := make([]dailyPoint, 0, days)
	for i := 0; i < days; i++ {
		key := from.AddDate(0, 0, i).Format("2006-01-02")
		if p, ok := dailyMap[key]; ok {
			daily = append(daily, p)
		} else {
			daily = append(daily, dailyPoint{Date: key})
		}
	}

	// Per-employee totals (every employee, even with no logs in the window).
	empRows, err := h.db.Query(r.Context(),
		`SELECT u.id, u.email, u.can_track, u.hourly_rate_cents,
		        COALESCE(SUM(t.duration_seconds),0)::int,
		        COALESCE(AVG(t.activity_percent),0)::int,
		        MAX(t.ended_at),
		        COALESCE(`+billableExpr+`,0)
		 FROM users u
		 LEFT JOIN time_logs t
		        ON t.user_id = u.id AND t.started_at::date BETWEEN $1::date AND $2::date
		 LEFT JOIN projects p ON p.id = t.project_id
		 WHERE u.role='employee'`+uOrg+`
		 GROUP BY u.id, u.email, u.can_track, u.hourly_rate_cents
		 ORDER BY 5 DESC, u.email ASC`,
		args...,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	employees := make([]employeeSummary, 0)
	for empRows.Next() {
		var e employeeSummary
		if err := empRows.Scan(&e.UserID, &e.Email, &e.CanTrack, &e.HourlyRateCents,
			&e.TotalSeconds, &e.AvgActivity, &e.LastActive, &e.BillableCents); err != nil {
			continue
		}
		employees = append(employees, e)
	}
	empRows.Close()

	// Per-project totals (NULL project_id rolls up into "Unassigned").
	projRows, err := h.db.Query(r.Context(),
		`SELECT p.id, p.name,
		        SUM(t.duration_seconds)::int,
		        COALESCE(AVG(t.activity_percent),0)::int,
		        `+billableExpr+`
		 FROM time_logs t
		 JOIN users u ON u.id = t.user_id
		 LEFT JOIN projects p ON p.id = t.project_id
		 WHERE t.started_at::date BETWEEN $1::date AND $2::date`+tOrg+`
		 GROUP BY p.id, p.name
		 ORDER BY 3 DESC`,
		args...,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	projects := make([]projectSummary, 0)
	for projRows.Next() {
		var ps projectSummary
		var name *string
		if err := projRows.Scan(&ps.ProjectID, &name, &ps.TotalSeconds, &ps.AvgActivity, &ps.BillableCents); err != nil {
			continue
		}
		if name != nil {
			ps.Name = *name
		} else {
			ps.Name = "Unassigned"
		}
		projects = append(projects, ps)
	}
	projRows.Close()

	// Headline totals.
	var totalSeconds int
	var totalBillable int64
	activeDays, weightedAct := 0, 0
	for _, p := range daily {
		totalSeconds += p.TotalSeconds
		totalBillable += p.BillableCents
		if p.TotalSeconds > 0 {
			weightedAct += p.AvgActivity
			activeDays++
		}
	}
	avgActivity := 0
	if activeDays > 0 {
		avgActivity = weightedAct / activeDays
	}
	activeToday := 0
	if len(daily) > 0 {
		activeToday = daily[len(daily)-1].ActiveUsers
	}

	resp := map[string]any{
		"from":      fromS,
		"to":        toS,
		"days":      days,
		"currency":  currencyCode(),
		"daily":     daily,
		"employees": employees,
		"projects":  projects,
		"totals": map[string]any{
			"total_seconds":  totalSeconds,
			"avg_activity":   avgActivity,
			"active_today":   activeToday,
			"employee_count": len(employees),
			"billable_cents": totalBillable,
		},
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
