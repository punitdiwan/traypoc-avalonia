package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/smtp"
	"os"
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
		ID             string      `json:"id"`
		Email          string      `json:"email"`
		FullName       string      `json:"full_name"`
		Role           models.Role `json:"role"`
		CanTrack       bool        `json:"can_track"`
		AllowManualTime bool       `json:"allow_manual_time"`
		AllowDelete    bool        `json:"allow_delete"`
		RequireNotes   bool        `json:"require_notes"`
		OrgID          string      `json:"org_id"`
		OrgName        string      `json:"org_name"`
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
		`SELECT u.id, u.email, u.full_name, u.password_hash, u.role, u.can_track, u.allow_manual_time, u.allow_delete, u.require_notes, u.org_id,
		        COALESCE(o.name, ''), u.created_at
		 FROM users u LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.email=$1`,
		req.Email,
	).Scan(&user.ID, &user.Email, &user.FullName, &user.PasswordHash, &user.Role, &user.CanTrack,
		&user.AllowManualTime, &user.AllowDelete, &user.RequireNotes, &user.OrgID, &orgName, &user.CreatedAt)
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
		`SELECT u.id, u.email, u.full_name, u.role, u.can_track, u.allow_manual_time, u.allow_delete, u.require_notes, u.org_id, COALESCE(o.name, '')
		 FROM users u LEFT JOIN organizations o ON o.id = u.org_id
		 WHERE u.id=$1`, userID,
	).Scan(&user.ID, &user.Email, &user.FullName, &user.Role, &user.CanTrack, &user.AllowManualTime, &user.AllowDelete, &user.RequireNotes, &user.OrgID, &orgName)
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
	resp.User.AllowManualTime = user.AllowManualTime
	resp.User.AllowDelete = user.AllowDelete
	resp.User.RequireNotes = user.RequireNotes
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
			`SELECT u.id, u.email, u.full_name, u.role, u.can_track, u.allow_manual_time, u.allow_delete, u.require_notes, u.hourly_rate_cents,
			        u.org_id, COALESCE(o.name, ''), u.created_at
			 FROM users u LEFT JOIN organizations o ON o.id = u.org_id
			 WHERE u.id=$1`, userID,
		).Scan(&user.ID, &user.Email, &user.FullName, &user.Role, &user.CanTrack, &user.AllowManualTime, &user.AllowDelete, &user.RequireNotes, &user.HourlyRateCents,
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

// ChangePassword lets an authenticated user update their own password.
// Requires the current password for verification; no privilege escalation possible.
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	userID, err := uuid.Parse(mw.UserID(r))
	if err != nil {
		http.Error(w, "bad user id", http.StatusBadRequest)
		return
	}
	var body struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
		body.CurrentPassword == "" || body.NewPassword == "" {
		http.Error(w, "current_password and new_password required", http.StatusBadRequest)
		return
	}
	if len(body.NewPassword) < 8 {
		http.Error(w, "new password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	var hash string
	if err := h.db.QueryRow(r.Context(),
		`SELECT password_hash FROM users WHERE id=$1`, userID,
	).Scan(&hash); err != nil {
		http.Error(w, "user not found", http.StatusNotFound)
		return
	}
	if !auth.CheckPassword(hash, body.CurrentPassword) {
		http.Error(w, "current password is incorrect", http.StatusUnauthorized)
		return
	}

	newHash, err := auth.HashPassword(body.NewPassword)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if _, err := h.db.Exec(r.Context(),
		`UPDATE users SET password_hash=$1 WHERE id=$2`, newHash, userID,
	); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ForgotPassword issues a one-time reset link for the given email. Always
// responds 200 whether or not the email exists (no user enumeration). If SMTP
// is configured, sends an email; otherwise logs the link to stdout (dev mode).
func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
		http.Error(w, "email required", http.StatusBadRequest)
		return
	}

	var userID uuid.UUID
	err := h.db.QueryRow(r.Context(),
		`SELECT id FROM users WHERE email=$1`, body.Email,
	).Scan(&userID)
	if err != nil {
		// Unknown email — respond the same as success to avoid enumeration.
		w.WriteHeader(http.StatusOK)
		return
	}

	// Generate a 32-byte random token; store SHA-256 hash in DB.
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	tokenPlain := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(tokenPlain))
	tokenHash := hex.EncodeToString(sum[:])

	// Delete any previous unused token for this user before inserting a new one.
	h.db.Exec(r.Context(),
		`DELETE FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL`, userID)

	if _, err := h.db.Exec(r.Context(),
		`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
		userID, tokenHash,
	); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Build the reset URL. CORS_ORIGIN doubles as the web app's base URL; fall back
	// to localhost for local dev.
	origin := os.Getenv("CORS_ORIGIN")
	if origin == "" {
		origin = "http://localhost:5173"
	}
	resetURL := fmt.Sprintf("%s/reset-password?token=%s", origin, tokenPlain)

	sendResetEmail(body.Email, resetURL)
	w.WriteHeader(http.StatusOK)
}

// ResetPassword validates a one-time token and updates the user's password.
func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token       string `json:"token"`
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
		body.Token == "" || body.NewPassword == "" {
		http.Error(w, "token and new_password required", http.StatusBadRequest)
		return
	}
	if len(body.NewPassword) < 8 {
		http.Error(w, "new password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	sum := sha256.Sum256([]byte(body.Token))
	tokenHash := hex.EncodeToString(sum[:])

	var tokenID uuid.UUID
	var userID uuid.UUID
	err := h.db.QueryRow(r.Context(),
		`SELECT id, user_id FROM password_reset_tokens
		 WHERE token_hash=$1 AND used_at IS NULL AND expires_at > NOW()`,
		tokenHash,
	).Scan(&tokenID, &userID)
	if err != nil {
		http.Error(w, "invalid or expired reset token", http.StatusBadRequest)
		return
	}

	newHash, err := auth.HashPassword(body.NewPassword)
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

	if _, err := tx.Exec(r.Context(),
		`UPDATE users SET password_hash=$1 WHERE id=$2`, newHash, userID,
	); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1`, tokenID,
	); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// sendResetEmail sends the reset link by email if SMTP is configured; otherwise
// logs it to stdout so dev environments still work without an email server.
func sendResetEmail(toEmail, resetURL string) {
	host := os.Getenv("SMTP_HOST")
	if host == "" {
		log.Printf("[FORGOT PASSWORD] Reset URL for %s → %s\n", toEmail, resetURL)
		return
	}
	port := os.Getenv("SMTP_PORT")
	if port == "" {
		port = "587"
	}
	user := os.Getenv("SMTP_USER")
	pass := os.Getenv("SMTP_PASS")
	from := os.Getenv("SMTP_FROM")
	if from == "" {
		from = user
	}

	subject := "Reset your TimeTracker password"
	body := fmt.Sprintf("Click the link below to reset your password (expires in 1 hour):\n\n%s\n\nIf you did not request this, ignore this email.", resetURL)
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\n\r\n%s", from, toEmail, subject, body)

	addr := fmt.Sprintf("%s:%s", host, port)
	var a smtp.Auth
	if user != "" {
		a = smtp.PlainAuth("", user, pass, host)
	}
	if err := smtp.SendMail(addr, a, from, []string{toEmail}, []byte(msg)); err != nil {
		log.Printf("[FORGOT PASSWORD] SMTP send failed for %s: %v (URL: %s)\n", toEmail, err, resetURL)
	}
}

// writeJSONError writes a JSON error body so the web can surface specific
// messages (e.g. the "You are a member of <Org>" signup conflict).
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
