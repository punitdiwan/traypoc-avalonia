package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/auth"
	"time-tracker/api/internal/models"
)

type AuthHandler struct {
	db *pgxpool.Pool
}

func NewAuthHandler(db *pgxpool.Pool) *AuthHandler {
	return &AuthHandler{db: db}
}

type registerRequest struct {
	Email    string      `json:"email"`
	Password string      `json:"password"`
	Role     models.Role `json:"role"`
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
		Role     models.Role `json:"role"`
		CanTrack bool        `json:"can_track"`
	} `json:"user"`
}

func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.Email == "" || req.Password == "" {
		http.Error(w, "email and password required", http.StatusBadRequest)
		return
	}
	if req.Role == "" {
		req.Role = models.RoleEmployee
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	var user models.User
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3)
		 RETURNING id, email, role, can_track, created_at`,
		req.Email, hash, req.Role,
	).Scan(&user.ID, &user.Email, &user.Role, &user.CanTrack, &user.CreatedAt)
	if err != nil {
		http.Error(w, "email already registered", http.StatusConflict)
		return
	}

	h.issueTokens(w, user)
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	var user models.User
	err := h.db.QueryRow(r.Context(),
		`SELECT id, email, password_hash, role, can_track, created_at FROM users WHERE email=$1`,
		req.Email,
	).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.Role, &user.CanTrack, &user.CreatedAt)
	if err != nil || !auth.CheckPassword(user.PasswordHash, req.Password) {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	// Desktop login requires time tracking to be enabled by an employer.
	if user.Role == models.RoleEmployee && !user.CanTrack {
		http.Error(w, "time tracking not enabled for your account", http.StatusForbidden)
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
	err = h.db.QueryRow(r.Context(),
		`SELECT id, email, role, can_track FROM users WHERE id=$1`, userID,
	).Scan(&user.ID, &user.Email, &user.Role, &user.CanTrack)
	if err != nil {
		http.Error(w, "user not found", http.StatusUnauthorized)
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
	accessToken, err := auth.GenerateAccessToken(user.ID, user.Role)
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
	resp.User.Role = user.Role
	resp.User.CanTrack = user.CanTrack

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)
}

// Me returns the current authenticated user.
func Me(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rawID := r.Context().Value("userID").(string)
		userID, err := uuid.Parse(rawID)
		if err != nil {
			http.Error(w, "bad user id", http.StatusBadRequest)
			return
		}
		var user models.User
		err = db.QueryRow(r.Context(),
			`SELECT id, email, role, can_track, created_at FROM users WHERE id=$1`, userID,
		).Scan(&user.ID, &user.Email, &user.Role, &user.CanTrack, &user.CreatedAt)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(user)
	}
}
