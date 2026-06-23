package handlers

import (
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
)

type AppCategoryHandler struct {
	db *pgxpool.Pool
}

func NewAppCategoryHandler(db *pgxpool.Pool) *AppCategoryHandler {
	return &AppCategoryHandler{db: db}
}

type appSeenRow struct {
	AppName      string  `json:"app_name"`
	TotalSeconds int     `json:"total_seconds"`
	Category     *string `json:"category"`
}

// List returns all distinct app names seen in the org's time logs, with total
// seconds and the employer's category tag (null when not yet categorized).
func (h *AppCategoryHandler) List(w http.ResponseWriter, r *http.Request) {
	orgID := mw.OrgID(r)

	rows, err := h.db.Query(r.Context(), `
		SELECT t.app_name,
		       SUM(t.duration_seconds)::int AS total_seconds,
		       ac.category
		FROM time_logs t
		LEFT JOIN app_categories ac ON ac.org_id = $1 AND ac.app_name = t.app_name
		WHERE t.org_id = $1
		  AND t.app_name IS NOT NULL
		  AND t.app_name <> ''
		GROUP BY t.app_name, ac.category
		ORDER BY total_seconds DESC
		LIMIT 200
	`, orgID)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var result []appSeenRow
	for rows.Next() {
		var row appSeenRow
		if err := rows.Scan(&row.AppName, &row.TotalSeconds, &row.Category); err != nil {
			continue
		}
		result = append(result, row)
	}
	if result == nil {
		result = []appSeenRow{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// Upsert sets or replaces the category for an app name in the caller's org.
// Body: {"category": "productive"|"neutral"|"unproductive"}
func (h *AppCategoryHandler) Upsert(w http.ResponseWriter, r *http.Request) {
	orgID := mw.OrgID(r)
	appName, err := url.PathUnescape(chi.URLParam(r, "appName"))
	if err != nil || appName == "" {
		http.Error(w, "invalid app name", http.StatusBadRequest)
		return
	}

	var body struct {
		Category string `json:"category"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	switch body.Category {
	case "productive", "neutral", "unproductive":
	default:
		http.Error(w, "category must be productive, neutral, or unproductive", http.StatusBadRequest)
		return
	}

	_, err = h.db.Exec(r.Context(), `
		INSERT INTO app_categories (org_id, app_name, category)
		VALUES ($1, $2, $3)
		ON CONFLICT (org_id, app_name) DO UPDATE SET category = EXCLUDED.category
	`, orgID, appName, body.Category)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Delete removes the category tag for an app name, leaving it uncategorized.
func (h *AppCategoryHandler) Delete(w http.ResponseWriter, r *http.Request) {
	orgID := mw.OrgID(r)
	appName, err := url.PathUnescape(chi.URLParam(r, "appName"))
	if err != nil || appName == "" {
		http.Error(w, "invalid app name", http.StatusBadRequest)
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM app_categories WHERE org_id=$1 AND app_name=$2`,
		orgID, appName)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
