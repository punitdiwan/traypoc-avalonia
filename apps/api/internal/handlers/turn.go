package handlers

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	mw "time-tracker/api/internal/middleware"
)

// TURNHandler issues short-lived ICE server credentials for WebRTC.
//
// It implements coturn's "TURN REST API" time-limited credential scheme
// (use-auth-secret): username = "<expiry-unix>:<userid>", password =
// base64(HMAC-SHA1(static-auth-secret, username)). coturn validates these
// without any shared user database.
type TURNHandler struct{}

func NewTURNHandler() *TURNHandler { return &TURNHandler{} }

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func (h *TURNHandler) Get(w http.ResponseWriter, r *http.Request) {
	servers := []iceServer{}

	// Public STUN is always useful and free.
	if stun := os.Getenv("STUN_URL"); stun != "" {
		servers = append(servers, iceServer{URLs: []string{stun}})
	} else {
		servers = append(servers, iceServer{URLs: []string{"stun:stun.l.google.com:19302"}})
	}

	// TURN relay (required on mobile/strict NAT) when configured. No free public
	// relay is wired in — OpenRelay (metered.ca) static-cred service is dead — so
	// strict/symmetric-NAT calls need a self-hosted coturn via TURN_HOST/TURN_SECRET.
	turnHost := os.Getenv("TURN_HOST") // e.g. turn:turn.example.com:3478
	secret := os.Getenv("TURN_SECRET") // coturn static-auth-secret
	if turnHost != "" && secret != "" {
		ttl := 12 * time.Hour
		expiry := time.Now().Add(ttl).Unix()
		username := strconv.FormatInt(expiry, 10) + ":" + mw.UserID(r)

		mac := hmac.New(sha1.New, []byte(secret))
		mac.Write([]byte(username))
		cred := base64.StdEncoding.EncodeToString(mac.Sum(nil))

		urls := strings.Split(turnHost, ",") // allow multiple transports
		servers = append(servers, iceServer{
			URLs:       urls,
			Username:   username,
			Credential: cred,
		})
	}

	writeJSON(w, map[string]any{"ice_servers": servers})
}
