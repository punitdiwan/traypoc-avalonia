package report

import (
	"bytes"
	"context"
	"fmt"
	"html/template"
	"net/smtp"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type DayStat struct {
	Date        string
	TotalHours  float64
	AvgActivity int
	Intervals   int
}

type WeeklyData struct {
	Email      string
	WeekStart  string
	WeekEnd    string
	TotalHours float64
	AvgActivity int
	Days       []DayStat
	DashURL    string
}

var reportTmpl = template.Must(template.New("weekly").Parse(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background:#f8fafc; margin:0; padding:32px; color:#1e293b; }
  .card { background:#fff; border-radius:12px; border:1px solid #e2e8f0;
          max-width:560px; margin:0 auto; padding:32px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#64748b; font-size:14px; margin:0 0 24px; }
  .stats { display:flex; gap:16px; margin-bottom:24px; }
  .stat { flex:1; background:#f1f5f9; border-radius:8px; padding:16px; text-align:center; }
  .stat-val { font-size:28px; font-weight:700; color:#0284c7; }
  .stat-lbl { font-size:12px; color:#64748b; margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; padding:8px 12px; background:#f1f5f9;
       color:#64748b; font-weight:600; font-size:12px; border-radius:4px; }
  td { padding:8px 12px; border-bottom:1px solid #f1f5f9; }
  .bar { height:6px; border-radius:3px; background:#0ea5e9; display:inline-block; }
  .btn { display:inline-block; margin-top:24px; background:#0284c7; color:#fff;
         text-decoration:none; padding:10px 20px; border-radius:8px; font-size:14px;
         font-weight:600; }
  .footer { text-align:center; color:#94a3b8; font-size:12px; margin-top:24px; }
</style>
</head>
<body>
<div class="card">
  <h1>Weekly Time Report</h1>
  <p class="sub">{{ .WeekStart }} – {{ .WeekEnd }}</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-val">{{ printf "%.1f" .TotalHours }}h</div>
      <div class="stat-lbl">Total tracked</div>
    </div>
    <div class="stat">
      <div class="stat-val">{{ .AvgActivity }}%</div>
      <div class="stat-lbl">Avg activity</div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Day</th><th>Hours</th><th>Activity</th><th>Intervals</th></tr>
    </thead>
    <tbody>
    {{ range .Days }}
      <tr>
        <td>{{ .Date }}</td>
        <td>{{ printf "%.1f" .TotalHours }}h</td>
        <td>
          <span class="bar" style="width:{{ .AvgActivity }}px"></span>
          {{ .AvgActivity }}%
        </td>
        <td>{{ .Intervals }}</td>
      </tr>
    {{ end }}
    </tbody>
  </table>

  {{ if .DashURL }}
  <a href="{{ .DashURL }}" class="btn">View full diary →</a>
  {{ end }}

  <p class="footer">Time Tracker — automated weekly summary</p>
</div>
</body>
</html>`))

// QueryWeeklyData fetches the past 7 days of stats for a given user.
func QueryWeeklyData(ctx context.Context, db *pgxpool.Pool, userID, email string) (*WeeklyData, error) {
	now := time.Now().UTC()
	weekStart := now.AddDate(0, 0, -7).Truncate(24 * time.Hour)

	rows, err := db.Query(ctx, `
		SELECT
			started_at::date                  AS day,
			SUM(duration_seconds)             AS total_sec,
			COALESCE(AVG(activity_percent)::int, 0) AS avg_act,
			COUNT(*)                          AS intervals
		FROM time_logs
		WHERE user_id = $1
		  AND started_at >= $2
		GROUP BY day
		ORDER BY day ASC
	`, userID, weekStart)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var days []DayStat
	var totalSec int64
	var totalAct, count int

	for rows.Next() {
		var day time.Time
		var sec int64
		var act, intervals int
		if err := rows.Scan(&day, &sec, &act, &intervals); err != nil {
			continue
		}
		days = append(days, DayStat{
			Date:        day.Format("Mon Jan 2"),
			TotalHours:  float64(sec) / 3600,
			AvgActivity: act,
			Intervals:   intervals,
		})
		totalSec += sec
		totalAct += act
		count++
	}

	avgAct := 0
	if count > 0 {
		avgAct = totalAct / count
	}

	dashURL := os.Getenv("DASHBOARD_URL")

	return &WeeklyData{
		Email:       email,
		WeekStart:   weekStart.Format("Jan 2"),
		WeekEnd:     now.Format("Jan 2, 2006"),
		TotalHours:  float64(totalSec) / 3600,
		AvgActivity: avgAct,
		Days:        days,
		DashURL:     dashURL,
	}, nil
}

// Send sends the rendered HTML report via SMTP.
// Reads SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM from env.
func Send(data *WeeklyData) error {
	host := os.Getenv("SMTP_HOST")
	port := os.Getenv("SMTP_PORT")
	user := os.Getenv("SMTP_USER")
	pass := os.Getenv("SMTP_PASS")
	from := os.Getenv("SMTP_FROM")
	if from == "" {
		from = user
	}
	if host == "" || port == "" {
		return fmt.Errorf("SMTP_HOST / SMTP_PORT not configured")
	}

	var buf bytes.Buffer
	if err := reportTmpl.Execute(&buf, data); err != nil {
		return fmt.Errorf("template: %w", err)
	}

	msg := buildMIME(from, data.Email, "Your weekly time report", buf.String())

	addr := host + ":" + port
	var auth smtp.Auth
	if user != "" && pass != "" {
		auth = smtp.PlainAuth("", user, pass, host)
	}

	if err := smtp.SendMail(addr, auth, from, []string{data.Email}, msg); err != nil {
		return fmt.Errorf("smtp: %w", err)
	}
	return nil
}

func buildMIME(from, to, subject, htmlBody string) []byte {
	var b bytes.Buffer
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	return b.Bytes()
}
