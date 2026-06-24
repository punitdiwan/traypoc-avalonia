// Package handlers — LiveKit integration.
//
// LiveKit is an SFU: instead of negotiating a peer-to-peer mesh over our /ws
// signaling, both call participants connect to a LiveKit *room* (named after the
// call id) and the media server relays audio between them. Our WebSocket hub is
// still used to *ring* the callee ("join room <call_id>") and to persist call
// rows — see internal/realtime. This handler does two things:
//
//   - Token: mints a short-lived LiveKit join JWT for the signed-in user.
//   - StartRecording/StopRecording: drives LiveKit Egress (server-side room
//     recording → DO Spaces), wired to the employer's record toggle in the hub.
//
// We deliberately do NOT import github.com/livekit/server-sdk-go: its current
// release requires Go >= 1.26, while this module is pinned to Go 1.23 (see the
// Pion pin in CLAUDE.md). A LiveKit access token is just an HS256 JWT with a
// "video" grant claim, and Egress is a plain Twirp/JSON HTTP endpoint — both are
// stable, so we build them with the jwt/v5 dep we already have + net/http.
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
	"time-tracker/api/internal/spaces"
)

// videoGrant is the LiveKit "video" claim. Field names are the camelCase wire
// names LiveKit expects. Pointer bools so an unset permission is omitted (LiveKit
// then applies its own default) rather than serialized as false.
type videoGrant struct {
	Room           string `json:"room,omitempty"`
	RoomJoin       bool   `json:"roomJoin,omitempty"`
	RoomRecord     bool   `json:"roomRecord,omitempty"`
	CanPublish     *bool  `json:"canPublish,omitempty"`
	CanSubscribe   *bool  `json:"canSubscribe,omitempty"`
	CanPublishData *bool  `json:"canPublishData,omitempty"`
}

type lkClaims struct {
	Video videoGrant `json:"video"`
	Name  string     `json:"name,omitempty"`
	jwt.RegisteredClaims
}

type LiveKitHandler struct {
	db        *pgxpool.Pool
	publicURL string // wss URL clients connect to, e.g. wss://livekit.example.com
	httpURL   string // same host over http(s), for the Egress Twirp API
	apiKey    string
	apiSecret string

	recordEnabled bool
	s3            spaces.Config

	mu      sync.Mutex
	egress  map[string]string // callID -> egressID (for StopEgress)
	httpCli *http.Client
}

// NewLiveKitHandler reads LIVEKIT_* from the environment. Returns (nil, false)
// when LiveKit isn't configured, so the caller can leave calls on the legacy
// mesh path. Recording additionally requires LIVEKIT_RECORD=1 and DO_SPACES_*.
func NewLiveKitHandler(db *pgxpool.Pool, getenv func(string) string, s3 spaces.Config) (*LiveKitHandler, bool) {
	url := strings.TrimRight(getenv("LIVEKIT_URL"), "/")
	key := getenv("LIVEKIT_API_KEY")
	secret := getenv("LIVEKIT_API_SECRET")
	if url == "" || key == "" || secret == "" {
		return nil, false
	}
	// Egress talks to the LiveKit server's HTTP API on the same host.
	httpURL := url
	if strings.HasPrefix(httpURL, "ws") {
		httpURL = "http" + strings.TrimPrefix(httpURL, "ws") // ws->http, wss->https
	}
	record := getenv("LIVEKIT_RECORD") == "1" && s3.IsConfigured()
	return &LiveKitHandler{
		db:            db,
		publicURL:     url,
		httpURL:       httpURL,
		apiKey:        key,
		apiSecret:     secret,
		recordEnabled: record,
		s3:            s3,
		egress:        make(map[string]string),
		httpCli:       &http.Client{Timeout: 10 * time.Second},
	}, true
}

// RecordingEnabled reports whether server-side Egress recording is active.
func (h *LiveKitHandler) RecordingEnabled() bool { return h != nil && h.recordEnabled }

func boolPtr(b bool) *bool { return &b }

func (h *LiveKitHandler) buildToken(identity, name string, grant videoGrant, ttl time.Duration) (string, error) {
	now := time.Now()
	claims := lkClaims{
		Video: grant,
		Name:  name,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    h.apiKey,
			Subject:   identity,
			ID:        identity + "-" + strconv.FormatInt(now.UnixNano(), 10),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(h.apiSecret))
}

// Token issues a join token for ?room=<call_id>. The room is created on demand
// when the first participant connects. Authorization for who may call whom is
// enforced by the signaling hub (employer<->employee, same org) before the
// callee is ever rung; here we just gate on a valid session + a room name.
func (h *LiveKitHandler) Token(w http.ResponseWriter, r *http.Request) {
	room := r.URL.Query().Get("room")
	if room == "" {
		http.Error(w, "room required", http.StatusBadRequest)
		return
	}
	tok, err := h.buildToken(mw.UserID(r), "", videoGrant{
		Room:           room,
		RoomJoin:       true,
		CanPublish:     boolPtr(true),
		CanSubscribe:   boolPtr(true),
		CanPublishData: boolPtr(true),
	}, 6*time.Hour)
	if err != nil {
		http.Error(w, "token error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"url": h.publicURL, "token": tok})
}

// MessagingToken mints a data-only LiveKit join token for a 1:1 chat "inbox"
// room. Chat between an employer and an employee both flows through a single
// persistent room named after the *employee* ("dm-<employeeId>"): the employee
// stays joined to their own inbox (so any admin message arrives + pops up), and
// an employer joins that employee's inbox while a conversation is open.
//
// Room selection + authorization:
//   - employee caller -> their own inbox ("dm-<self>"); no ?with needed.
//   - employer caller -> requires ?with=<employeeId> in the same org.
//   - god caller       -> requires ?with=<employeeId>, any org.
//
// The token grants data publish/subscribe but no media (chat carries no audio).
func (h *LiveKitHandler) MessagingToken(w http.ResponseWriter, r *http.Request) {
	me := mw.UserID(r)
	myRole := mw.Role(r)

	var employeeID string
	if myRole == models.RoleEmployee {
		employeeID = me
	} else {
		other := r.URL.Query().Get("with")
		if other == "" {
			http.Error(w, "with required", http.StatusBadRequest)
			return
		}
		if myRole != models.RoleGod {
			var ok bool
			if err := h.db.QueryRow(r.Context(),
				`SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND org_id = $2 AND role = 'employee')`,
				other, mw.OrgID(r),
			).Scan(&ok); err != nil || !ok {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		employeeID = other
	}

	room := "dm-" + employeeID
	tok, err := h.buildToken(me, "", videoGrant{
		Room:           room,
		RoomJoin:       true,
		CanPublish:     boolPtr(false), // chat is data-only, no media
		CanSubscribe:   boolPtr(true),
		CanPublishData: boolPtr(true),
	}, 12*time.Hour)
	if err != nil {
		http.Error(w, "token error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"url": h.publicURL, "token": tok, "room": room})
}

// --- Egress (server-side recording) ---

// StartRecording records the call's room to an audio-only OGG in Spaces. Wired to
// hub.OnRecord, so it fires when the employer's client enables recording. The
// call_recordings row is inserted up front with the deterministic object URL; the
// file itself materializes once Egress finalizes (on hangup / room close). No-op
// unless recording is enabled. Signature matches realtime.RecordFunc.
func (h *LiveKitHandler) StartRecording(ctx context.Context, callID, _ string) {
	if !h.recordEnabled || callID == "" {
		return
	}
	h.mu.Lock()
	already := h.egress[callID] != ""
	h.mu.Unlock()
	if already {
		return
	}

	filepath := "call-recordings/" + callID + ".ogg"
	req := map[string]any{
		"room_name":  callID,
		"audio_only": true,
		"file_outputs": []map[string]any{{
			"file_type": "OGG",
			"filepath":  filepath,
			"s3": map[string]any{
				"access_key":       h.s3.Key,
				"secret":           h.s3.Secret,
				"region":           h.s3.Region,
				"bucket":           h.s3.Bucket,
				"endpoint":         fmt.Sprintf("https://%s.digitaloceanspaces.com", h.s3.Region),
				"force_path_style": false,
			},
		}},
	}
	var resp struct {
		EgressID string `json:"egress_id"`
	}
	if err := h.egressCall(ctx, "StartRoomCompositeEgress", req, &resp); err != nil {
		log.Printf("livekit: start egress for %s: %v", callID, err)
		return
	}

	h.mu.Lock()
	h.egress[callID] = resp.EgressID
	h.mu.Unlock()

	url := fmt.Sprintf("https://%s.%s.digitaloceanspaces.com/%s", h.s3.Bucket, h.s3.Region, filepath)
	if _, err := h.db.Exec(ctx,
		`INSERT INTO call_recordings (call_id, storage_url, format) VALUES ($1,$2,'ogg')`,
		callID, url,
	); err != nil {
		log.Printf("livekit: insert recording row for %s: %v", callID, err)
	}
}

// StopRecording stops the Egress for a call. Wired to hub.OnRecordEnd (fires on
// hangup/reject/cancel). Room-composite Egress also self-stops when the room
// empties, so this is a best-effort early stop. Signature matches RecordEndFunc.
func (h *LiveKitHandler) StopRecording(callID string) {
	if !h.recordEnabled || callID == "" {
		return
	}
	h.mu.Lock()
	id := h.egress[callID]
	delete(h.egress, callID)
	h.mu.Unlock()
	if id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.egressCall(ctx, "StopEgress", map[string]any{"egress_id": id}, nil); err != nil {
		log.Printf("livekit: stop egress %s: %v", id, err)
	}
}

// egressCall POSTs a Twirp/JSON request to the LiveKit Egress service, authed
// with a roomRecord-grant token. out may be nil.
func (h *LiveKitHandler) egressCall(ctx context.Context, method string, body any, out any) error {
	tok, err := h.buildToken("egress", "", videoGrant{RoomRecord: true}, time.Hour)
	if err != nil {
		return err
	}
	buf, _ := json.Marshal(body)
	url := h.httpURL + "/twirp/livekit.Egress/" + method
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := h.httpCli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var b bytes.Buffer
		_, _ = b.ReadFrom(resp.Body)
		return fmt.Errorf("egress %s: HTTP %d: %s", method, resp.StatusCode, strings.TrimSpace(b.String()))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}
