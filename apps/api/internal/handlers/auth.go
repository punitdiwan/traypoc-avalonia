package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/auth"
	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
)

type AuthHandler struct {
	db *pgxpool.Pool
}

func NewAuthHandler(db *pgxpool.Pool) *AuthHandler {
	return &AuthHandler{db: db}
}

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	OrgName  string `json:"org_name"`
	FullName string `json:"full_name"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	User         struct {
		ID       string      `json:"id"`
		Email    string      `json:"email"`
		FullName string      `json:"full_name"`
		Role        models.Role `json:"role"`
		CanTrack    bool        `json:"can_track"`
		AllowDelete bool        `json:"allow_delete"`
		OrgID       string      `json:"org_id"`
		OrgName     string      `json:"org_name"`
	} `json:"user"`
}

// Register is the self-serve signup flow: it creates a new organization and
// makes the signer its owner (an employer). If the email already belongs to an
// organization, signup is rejected with the member's org name. Employees are
// added to an existing org via POST /users (see UserHandler.Invite), not here.
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	req.FullName = normalizeName(req.FullName)
	if req.Email == "" || req.Password == "" || req.OrgName == "" || req.FullName == "" {
		http.Error(w, "email, password, org_name and full_name required", http.StatusBadRequest)
		return
	}

	// Reject if this email already belongs to an organization.
	var existingOrg string
	err := h.db.QueryRow(r.Context(),
		`SELECT COALESCE(o.name, '') FROM users u
		 LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.email=$1 AND u.org_id IS NOT NULL`,
		req.Email,
	).Scan(&existingOrg)
	if err == nil {
		writeJSONError(w, http.StatusConflict, "You are a member of "+existingOrg)
		return
	}

	hash, err := auth.HashPassword(req.Password)
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

	// Create the owner user (or claim an existing org-less / released row).
	var user models.User
	err = tx.QueryRow(r.Context(),
		`INSERT INTO users (email, password_hash, role, can_track, full_name)
		 VALUES ($1,$2,'employer',false,$3)
		 ON CONFLICT (email) DO UPDATE
		   SET password_hash=EXCLUDED.password_hash, role='employer', full_name=EXCLUDED.full_name
		 RETURNING id, email, full_name, role, can_track, created_at`,
		req.Email, hash, req.FullName,
	).Scan(&user.ID, &user.Email, &user.FullName, &user.Role, &user.CanTrack, &user.CreatedAt)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	var orgID uuid.UUID
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO organizations (name, owner_id) VALUES ($1,$2) RETURNING id`,
		req.OrgName, user.ID,
	).Scan(&orgID); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if _, err := tx.Exec(r.Context(),
		`UPDATE users SET org_id=$1 WHERE id=$2`, orgID, user.ID,
	); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	user.OrgID = &orgID
	user.OrgName = req.OrgName
	h.issueTokens(w, user)
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	var user models.User
	var orgName string
	err := h.db.QueryRow(r.Context(),
		`SELECT u.id, u.email, u.full_name, u.password_hash, u.role, u.can_track, u.allow_delete, u.org_id,
		        COALESCE(o.name, ''), u.created_at
		 FROM users u LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.email=$1`,
		req.Email,
	).Scan(&user.ID, &user.Email, &user.FullName, &user.PasswordHash, &user.Role, &user.CanTrack,
		&user.AllowDelete, &user.OrgID, &orgName, &user.CreatedAt)
	if err != nil || !auth.CheckPassword(user.PasswordHash, req.Password) {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}
	user.OrgName = orgName

	// Org membership is the auth gate: everyone except god must belong to an
	// organization. A released member has no org until re-invited (or until they
	// sign up to start their own). can_track is NOT checked here — it's a live,
	// reversible tracking switch, not an access gate: a paused employee may still
	// sign in (and lands on a paused state), capture is governed by the policy
	// poll and enforced on writes (see PolicyHandler / timelogs.Create).
	if user.Role != models.RoleGod && user.OrgID == nil {
		http.Error(w, "your account is not part of an organization", http.StatusForbidden)
		return
	}

	h.issueTokens(w, user)
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	// Accept refresh token from request body (desktop) or httpOnly cookie (web).
	var token string
	var req refreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err == nil && req.RefreshToken != "" {
		token = req.RefreshToken
	} else if cookie, err := r.Cookie("refresh_token"); err == nil {
		token = cookie.Value
	}
	if token == "" {
		http.Error(w, "missing refresh token", http.StatusUnauthorized)
		return
	}

	userID, err := auth.ValidateRefreshToken(token)
	if err != nil {
		http.Error(w, "invalid refresh token", http.StatusUnauthorized)
		return
	}

	var user models.User
	var orgName string
	err = h.db.QueryRow(r.Context(),
		`SELECT u.id, u.email, u.full_name, u.role, u.can_track, u.org_id, COALESCE(o.name, '')
		 FROM users u LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.id=$1`, userID,
	).Scan(&user.ID, &user.Email, &user.FullName, &user.Role, &user.CanTrack, &user.OrgID, &orgName)
	if err != nil {
		http.Error(w, "user not found", http.StatusUnauthorized)
		return
	}
	user.OrgName = orgName

	// Re-validate org membership on every refresh: a session must not outlive the
	// member's seat. A released employee (org_id cleared) can no longer refresh and
	// the desktop logs itself out — the genuine revocation path. can_track is NOT
	// checked here: pausing tracking must not end the session (the poll pauses
	// capture and writes are refused, but the member stays signed in and resumes
	// automatically when re-enabled).
	if user.Role != models.RoleGod && user.OrgID == nil {
		http.Error(w, "your account is not part of an organization", http.StatusUnauthorized)
		return
	}

	h.issueTokens(w, user)
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *AuthHandler) issueTokens(w http.ResponseWriter, user models.User) {
	orgID := ""
	if user.OrgID != nil {
		orgID = user.OrgID.String()
	}
	accessToken, err := auth.GenerateAccessToken(user.ID, user.Role, orgID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	refreshToken, err := auth.GenerateRefreshToken(user.ID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    refreshToken,
		Path:     "/",
		Expires:  time.Now().Add(7 * 24 * time.Hour),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	var resp tokenResponse
	resp.AccessToken = accessToken
	resp.RefreshToken = refreshToken
	resp.User.ID = user.ID.String()
	resp.User.Email = user.Email
	resp.User.FullName = user.FullName
	resp.User.Role = user.Role
	resp.User.CanTrack = user.CanTrack
	resp.User.AllowDelete = user.AllowDelete
	resp.User.OrgID = orgID
	resp.User.OrgName = user.OrgName

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)
}

// Me returns the current authenticated user, including their organization.
func Me(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, err := uuid.Parse(mw.UserID(r))
		if err != nil {
			http.Error(w, "bad user id", http.StatusBadRequest)
			return
		}
		var user models.User
		var orgName string
		err = db.QueryRow(r.Context(),
			`SELECT u.id, u.email, u.full_name, u.role, u.can_track, u.allow_delete, u.hourly_rate_cents,
			        u.org_id, COALESCE(o.name, ''), u.created_at
			 FROM users u LEFT JOIN organizations o ON o.id = u.org_id
			 WHERE u.id=$1`, userID,
		).Scan(&user.ID, &user.Email, &user.FullName, &user.Role, &user.CanTrack, &user.AllowDelete, &user.HourlyRateCents,
			&user.OrgID, &orgName, &user.CreatedAt)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		user.OrgName = orgName
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(user)
	}
}

// UpdateMe lets the authenticated user edit their own profile (currently just
// their full name). Self-service for both web and desktop.
func (h *AuthHandler) UpdateMe(w http.ResponseWriter, r *http.Request) {
	userID, err := uuid.Parse(mw.UserID(r))
	if err != nil {
		http.Error(w, "bad user id", http.StatusBadRequest)
		return
	}
	var body struct {
		FullName string `json:"full_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	name := normalizeName(body.FullName)
	if name == "" {
		http.Error(w, "full_name required", http.StatusBadRequest)
		return
	}
	if _, err := h.db.Exec(r.Context(),
		`UPDATE users SET full_name=$1 WHERE id=$2`, name, userID,
	); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeJSONError writes a JSON error body so the web can surface specific
// messages (e.g. the "You are a member of <Org>" signup conflict).
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
