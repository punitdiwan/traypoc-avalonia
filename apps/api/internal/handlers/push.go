package handlers

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
)

type PushHandler struct {
	db *pgxpool.Pool
}

func NewPushHandler(db *pgxpool.Pool) *PushHandler {
	return &PushHandler{db: db}
}

// PublicKey returns the VAPID public key the browser needs to subscribe.
func (h *PushHandler) PublicKey(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"public_key": os.Getenv("VAPID_PUBLIC_KEY")})
}

type pushSubscribeRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// Subscribe stores (or refreshes) a Web Push subscription for the caller's device.
func (h *PushHandler) Subscribe(w http.ResponseWriter, r *http.Request) {
	var req pushSubscribeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Endpoint == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	_, err := h.db.Exec(r.Context(), `
		INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (endpoint) DO UPDATE
		SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
		mw.UserID(r), req.Endpoint, req.Keys.P256dh, req.Keys.Auth,
	)
	if err != nil {
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
