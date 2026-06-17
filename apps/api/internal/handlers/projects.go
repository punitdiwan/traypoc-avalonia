package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
)

type ProjectHandler struct {
	db *pgxpool.Pool
}

func NewProjectHandler(db *pgxpool.Pool) *ProjectHandler {
	return &ProjectHandler{db: db}
}

func (h *ProjectHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)

	// Employees see projects they're a member of; employers see all their own projects.
	rows, err := h.db.Query(r.Context(),
		`SELECT DISTINCT p.id, p.name, p.owner_id, p.hourly_rate_cents, p.created_at
		 FROM projects p
		 LEFT JOIN project_members pm ON pm.project_id = p.id
		 WHERE p.owner_id=$1 OR pm.user_id=$1
		 ORDER BY p.created_at DESC`,
		userID,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type project struct {
		ID              uuid.UUID `json:"id"`
		Name            string    `json:"name"`
		OwnerID         uuid.UUID `json:"owner_id"`
		HourlyRateCents int       `json:"hourly_rate_cents"`
		CreatedAt       time.Time `json:"created_at"`
	}
	var projects []project
	for rows.Next() {
		var p project
		if err := rows.Scan(&p.ID, &p.Name, &p.OwnerID, &p.HourlyRateCents, &p.CreatedAt); err == nil {
			projects = append(projects, p)
		}
	}
	if projects == nil {
		projects = []project{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(projects)
}

func (h *ProjectHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := mw.UserID(r)

	var req struct {
		Name            string `json:"name"`
		HourlyRateCents int    `json:"hourly_rate_cents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}
	if req.HourlyRateCents < 0 {
		req.HourlyRateCents = 0
	}

	var id uuid.UUID
	err := h.db.QueryRow(r.Context(),
		`INSERT INTO projects (name, owner_id, hourly_rate_cents) VALUES ($1,$2,$3) RETURNING id`,
		req.Name, userID, req.HourlyRateCents,
	).Scan(&id)
	if err != nil {
		http.Error(w, "insert error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": id.String()})
}

// Update changes a project's name and/or billable rate. Owner-only.
func (h *ProjectHandler) Update(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	ownerID := mw.UserID(r)

	var req struct {
		Name            *string `json:"name"`
		HourlyRateCents *int    `json:"hourly_rate_cents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.Name == nil && req.HourlyRateCents == nil {
		http.Error(w, "nothing to update", http.StatusBadRequest)
		return
	}
	if req.HourlyRateCents != nil && *req.HourlyRateCents < 0 {
		http.Error(w, "rate must be non-negative", http.StatusBadRequest)
		return
	}

	// COALESCE keeps the existing value for any field omitted from the request.
	tag, err := h.db.Exec(r.Context(),
		`UPDATE projects
		 SET name = COALESCE($1, name),
		     hourly_rate_cents = COALESCE($2, hourly_rate_cents)
		 WHERE id=$3 AND owner_id=$4`,
		req.Name, req.HourlyRateCents, projectID, ownerID,
	)
	if err != nil {
		http.Error(w, "update error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ProjectHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	ownerID := mw.UserID(r)

	// Verify requester owns the project.
	var exists bool
	h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2)`,
		projectID, ownerID,
	).Scan(&exists)
	if !exists {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	var req struct {
		UserID uuid.UUID `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	_, err := h.db.Exec(r.Context(),
		`INSERT INTO project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
		projectID, req.UserID,
	)
	if err != nil {
		http.Error(w, "insert error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *ProjectHandler) ListTasks(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	rows, err := h.db.Query(r.Context(),
		`SELECT id, project_id, name, created_at FROM tasks WHERE project_id=$1 ORDER BY created_at ASC`,
		projectID,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type task struct {
		ID        uuid.UUID `json:"id"`
		ProjectID uuid.UUID `json:"project_id"`
		Name      string    `json:"name"`
		CreatedAt time.Time `json:"created_at"`
	}
	var tasks []task
	for rows.Next() {
		var t task
		if err := rows.Scan(&t.ID, &t.ProjectID, &t.Name, &t.CreatedAt); err == nil {
			tasks = append(tasks, t)
		}
	}
	if tasks == nil {
		tasks = []task{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tasks)
}

func (h *ProjectHandler) CreateTask(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	ownerID := mw.UserID(r)

	var exists bool
	h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2)`,
		projectID, ownerID,
	).Scan(&exists)
	if !exists {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}

	var id uuid.UUID
	err := h.db.QueryRow(r.Context(),
		`INSERT INTO tasks (project_id, name) VALUES ($1,$2) RETURNING id`,
		projectID, req.Name,
	).Scan(&id)
	if err != nil {
		http.Error(w, "insert error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": id.String()})
}
