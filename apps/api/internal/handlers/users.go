package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/auth"
	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
)

type UserHandler struct {
	db *pgxpool.Pool
}

func NewUserHandler(db *pgxpool.Pool) *UserHandler {
	return &UserHandler{db: db}
}

// List returns the employees in the caller's organization (all employees for god).
func (h *UserHandler) List(w http.ResponseWriter, r *http.Request) {
	var (
		rows interface {
			Close()
			Next() bool
			Scan(...any) error
		}
		err error
	)
	if mw.IsGod(r) {
		rows, err = h.db.Query(r.Context(),
			`SELECT id, email, role, can_track, hourly_rate_cents, created_at
			 FROM users WHERE role='employee' ORDER BY created_at DESC`)
	} else {
		rows, err = h.db.Query(r.Context(),
			`SELECT id, email, role, can_track, hourly_rate_cents, created_at
			 FROM users WHERE role='employee' AND org_id=$1 ORDER BY created_at DESC`,
			mw.OrgID(r),
		)
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var users []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Email, &u.Role, &u.CanTrack, &u.HourlyRateCents, &u.CreatedAt); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		users = append(users, u)
	}
	if users == nil {
		users = []models.User{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(users)
}

// Invite creates a new employee inside the caller's organization with tracking
// enabled. Rejects emails already attached to any organization.
func (h *UserHandler) Invite(w http.ResponseWriter, r *http.Request) {
	orgID := mw.OrgID(r)
	if orgID == "" {
		http.Error(w, "your account is not part of an organization", http.StatusForbidden)
		return
	}

	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		http.Error(w, "email and password required", http.StatusBadRequest)
		return
	}

	// Reject if the email already belongs to an organization.
	var existingOrg string
	if err := h.db.QueryRow(r.Context(),
		`SELECT COALESCE(o.name, '') FROM users u
		 LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.email=$1 AND u.org_id IS NOT NULL`,
		req.Email,
	).Scan(&existingOrg); err == nil {
		writeJSONError(w, http.StatusConflict, "You are a member of "+existingOrg)
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Insert, or claim a previously-released (org-less) row with the same email.
	var id uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO users (email, password_hash, role, can_track, org_id)
		 VALUES ($1,$2,'employee',true,$3)
		 ON CONFLICT (email) DO UPDATE
		   SET password_hash=EXCLUDED.password_hash, role='employee',
		       can_track=true, org_id=EXCLUDED.org_id
		 RETURNING id`,
		req.Email, hash, orgID,
	).Scan(&id)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": id.String()})
}

// Release detaches an employee from the caller's organization: their org_id is
// cleared and tracking disabled, freeing the email to join/start another org.
// Their historical time logs and project rows keep their org_id, so billing
// history is retained.
func (h *UserHandler) Release(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	userID, err := uuid.Parse(idStr)
	if err != nil {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}

	// Scope to the caller's org (god may release anyone).
	var tag interface{ RowsAffected() int64 }
	if mw.IsGod(r) {
		tag, err = h.db.Exec(r.Context(),
			`UPDATE users SET org_id=NULL, can_track=false WHERE id=$1 AND role='employee'`,
			userID,
		)
	} else {
		tag, err = h.db.Exec(r.Context(),
			`UPDATE users SET org_id=NULL, can_track=false WHERE id=$1 AND role='employee' AND org_id=$2`,
			userID, mw.OrgID(r),
		)
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "employee not found", http.StatusNotFound)
		return
	}
	// Also drop their project assignments in this org so they stop appearing as a member.
	h.db.Exec(r.Context(),
		`DELETE FROM project_members pm USING projects p
		 WHERE pm.project_id=p.id AND pm.user_id=$1`, userID)

	w.WriteHeader(http.StatusNoContent)
}

// SetCanTrack toggles the can_track permission for an employee.
func (h *UserHandler) SetCanTrack(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	userID, err := uuid.Parse(idStr)
	if err != nil {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}

	var body struct {
		CanTrack bool `json:"can_track"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	tag, err := h.execScopedUserUpdate(r,
		`UPDATE users SET can_track=$1 WHERE id=$2 AND role='employee'`,
		body.CanTrack, userID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "employee not found", http.StatusNotFound)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// execScopedUserUpdate runs an employee UPDATE, appending an org_id filter for
// non-god callers so an employer can only mutate employees in their own org.
func (h *UserHandler) execScopedUserUpdate(r *http.Request, query string, args ...any) (interface{ RowsAffected() int64 }, error) {
	if mw.IsGod(r) {
		return h.db.Exec(r.Context(), query, args...)
	}
	return h.db.Exec(r.Context(), query+" AND org_id=$"+strconv.Itoa(len(args)+1), append(args, mw.OrgID(r))...)
}

// SetRate sets an employee's default billable rate (cents/hour).
func (h *UserHandler) SetRate(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	userID, err := uuid.Parse(idStr)
	if err != nil {
		http.Error(w, "invalid user id", http.StatusBadRequest)
		return
	}

	var body struct {
		HourlyRateCents int `json:"hourly_rate_cents"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if body.HourlyRateCents < 0 {
		http.Error(w, "rate must be non-negative", http.StatusBadRequest)
		return
	}

	tag, err := h.execScopedUserUpdate(r,
		`UPDATE users SET hourly_rate_cents=$1 WHERE id=$2 AND role='employee'`,
		body.HourlyRateCents, userID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "employee not found", http.StatusNotFound)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
