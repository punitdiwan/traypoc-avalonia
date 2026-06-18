package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/auth"
)

// AdminHandler serves god-only, cross-organization administration endpoints.
type AdminHandler struct {
	db *pgxpool.Pool
}

func NewAdminHandler(db *pgxpool.Pool) *AdminHandler {
	return &AdminHandler{db: db}
}

type orgSummary struct {
	ID            uuid.UUID `json:"id"`
	Name          string    `json:"name"`
	OwnerEmail    string    `json:"owner_email"`
	EmployeeCount int       `json:"employee_count"`
	CreatedAt     time.Time `json:"created_at"`
}

// ListOrgs returns every organization with its owner and employee count.
func (h *AdminHandler) ListOrgs(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.Query(r.Context(),
		`SELECT o.id, o.name, COALESCE(ow.email, ''), o.created_at,
		        (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id AND u.role='employee')
		 FROM organizations o
		 LEFT JOIN users ow ON ow.id = o.owner_id
		 ORDER BY o.created_at DESC`,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	orgs := []orgSummary{}
	for rows.Next() {
		var o orgSummary
		if err := rows.Scan(&o.ID, &o.Name, &o.OwnerEmail, &o.CreatedAt, &o.EmployeeCount); err == nil {
			orgs = append(orgs, o)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(orgs)
}

// CreateOrg creates a new organization and its owner (an employer) in one step.
// God-only. Rejects an owner email that already belongs to an organization.
func (h *AdminHandler) CreateOrg(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OrgName       string `json:"org_name"`
		OwnerEmail    string `json:"owner_email"`
		OwnerPassword string `json:"owner_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		req.OrgName == "" || req.OwnerEmail == "" || req.OwnerPassword == "" {
		http.Error(w, "org_name, owner_email and owner_password required", http.StatusBadRequest)
		return
	}

	var existingOrg string
	if err := h.db.QueryRow(r.Context(),
		`SELECT COALESCE(o.name, '') FROM users u
		 LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.email=$1 AND u.org_id IS NOT NULL`,
		req.OwnerEmail,
	).Scan(&existingOrg); err == nil {
		writeJSONError(w, http.StatusConflict, req.OwnerEmail+" is already a member of "+existingOrg)
		return
	}

	hash, err := auth.HashPassword(req.OwnerPassword)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	var ownerID uuid.UUID
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO users (email, password_hash, role, can_track)
		 VALUES ($1,$2,'employer',false)
		 ON CONFLICT (email) DO UPDATE
		   SET password_hash=EXCLUDED.password_hash, role='employer'
		 RETURNING id`,
		req.OwnerEmail, hash,
	).Scan(&ownerID); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	var orgID uuid.UUID
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO organizations (name, owner_id) VALUES ($1,$2) RETURNING id`,
		req.OrgName, ownerID,
	).Scan(&orgID); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if _, err := tx.Exec(r.Context(),
		`UPDATE users SET org_id=$1 WHERE id=$2`, orgID, ownerID,
	); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"org_id":   orgID.String(),
		"owner_id": ownerID.String(),
	})
}
