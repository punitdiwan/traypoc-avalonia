package middleware

import (
	"context"
	"net/http"
	"strings"

	"time-tracker/api/internal/auth"
	"time-tracker/api/internal/models"
)

type contextKey string

const (
	CtxUserID contextKey = "userID"
	CtxRole   contextKey = "role"
	CtxOrgID  contextKey = "orgID"
)

func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		claims, err := auth.ValidateAccessToken(strings.TrimPrefix(header, "Bearer "))
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), CtxUserID, claims.UserID)
		ctx = context.WithValue(ctx, CtxRole, claims.Role)
		ctx = context.WithValue(ctx, CtxOrgID, claims.OrgID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func RequireRole(roles ...models.Role) func(http.Handler) http.Handler {
	allowed := make(map[models.Role]bool, len(roles))
	for _, r := range roles {
		allowed[r] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			role, _ := r.Context().Value(CtxRole).(models.Role)
			// God is the unrestricted super-admin and passes every role gate.
			if role != models.RoleGod && !allowed[role] {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireGod gates endpoints to the god super-admin only.
func RequireGod(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if Role(r) != models.RoleGod {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func UserID(r *http.Request) string {
	v, _ := r.Context().Value(CtxUserID).(string)
	return v
}

func Role(r *http.Request) models.Role {
	v, _ := r.Context().Value(CtxRole).(models.Role)
	return v
}

// OrgID is the caller's organization id (empty for god / org-less users).
func OrgID(r *http.Request) string {
	v, _ := r.Context().Value(CtxOrgID).(string)
	return v
}

// IsGod reports whether the caller is the unrestricted super-admin.
func IsGod(r *http.Request) bool {
	return Role(r) == models.RoleGod
}
