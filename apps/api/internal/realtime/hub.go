// Package realtime is the WebSocket signaling layer for voice calls and chat.
//
// One Hub holds every live connection, keyed by user id (a user may have several
// devices/tabs open). Clients exchange small JSON envelopes; the server stamps
// the sender, authorizes the pair (employer <-> employee within one org), then
// relays to the target. Call lifecycle and chat history are persisted to
// Postgres as messages flow.
//
// v1 is single-instance (in-memory map). To run multiple API replicas, fan the
// relay out over Redis pub/sub — the routing seam is Hub.routeTo.
package realtime

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"time-tracker/api/internal/models"
)

// Envelope is the wire format for every signaling/chat message.
type Envelope struct {
	Type    string          `json:"type"`              // call-offer|call-answer|ice-candidate|call-accept|call-reject|call-cancel|hangup|chat-message
	To      string          `json:"to,omitempty"`      // target user id (set by sender)
	From    string          `json:"from,omitempty"`    // sender user id (stamped by the server)
	CallID  string          `json:"call_id,omitempty"` // ties signaling + chat to a call row
	Payload json.RawMessage `json:"payload,omitempty"` // SDP / ICE / chat body / TURN, opaque to the relay
}

// Message types.
const (
	TypeCallOffer  = "call-offer"
	TypeCallAnswer = "call-answer"
	TypeICE        = "ice-candidate"
	TypeCallAccept = "call-accept"
	TypeCallReject = "call-reject"
	TypeCallCancel = "call-cancel"
	TypeHangup     = "hangup"
	TypeChat       = "chat-message"
	TypeError      = "error"
	TypePresence   = "presence"

	// Recorder-bot signaling: the server-side Pion bot offers a recv-only audio
	// peer to each participant so it can capture and store the conversation.
	TypeRecordOffer  = "record-offer"
	TypeRecordAnswer = "record-answer"
	TypeRecordICE    = "record-ice"
	// Employer/god toggles server-side recording for a call on or off.
	TypeRecordControl = "record-control"
)

// Client is a single live WebSocket connection.
type Client struct {
	userID string
	orgID  string
	role   models.Role
	send   chan []byte
}

// RingFunc is called when an offer targets a (possibly offline) user, so the
// caller can fire a Web Push notification to wake/ring a closed PWA. Set by main
// wiring; nil-safe.
type RingFunc func(ctx context.Context, calleeID, callerName, callID string)

// RecordFunc is called when a call is answered, so a server-side recorder bot can
// join the call. Set by main wiring; nil-safe.
type RecordFunc func(ctx context.Context, callID, orgID string)

// RecordSignalFunc forwards a participant's record-answer / record-ice back to
// the recorder bot session for callID. Set by main wiring; nil-safe.
type RecordSignalFunc func(ctx context.Context, callID, from, typ string, payload json.RawMessage)

// RecordEndFunc tells the recorder bot to finalize and upload callID's recording.
// Set by main wiring; nil-safe.
type RecordEndFunc func(callID string)

// Hub routes envelopes between connected users and persists call/chat state.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*Client]struct{} // userID -> set of connections
	db      *pgxpool.Pool

	OnRing         RingFunc
	OnRecord       RecordFunc
	OnRecordSignal RecordSignalFunc
	OnRecordEnd    RecordEndFunc
}

// SendEnvelope marshals and delivers an envelope to a user's live connections.
// Used by the recorder bot to push record-offer / record-ice to participants.
func (h *Hub) SendEnvelope(userID string, env Envelope) bool {
	data, err := json.Marshal(env)
	if err != nil {
		return false
	}
	return h.routeTo(userID, data)
}

func NewHub(db *pgxpool.Pool) *Hub {
	return &Hub{
		clients: make(map[string]map[*Client]struct{}),
		db:      db,
	}
}

func (h *Hub) register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.clients[c.userID]
	if set == nil {
		set = make(map[*Client]struct{})
		h.clients[c.userID] = set
	}
	set[c] = struct{}{}
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set := h.clients[c.userID]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.clients, c.userID)
		}
	}
}

// IsOnline reports whether a user has at least one live connection.
func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

// routeTo delivers raw bytes to every live connection of a user. Returns true if
// at least one connection accepted the message. This is the seam to swap for
// Redis pub/sub in a multi-instance deployment.
func (h *Hub) routeTo(userID string, data []byte) bool {
	h.mu.RLock()
	set := h.clients[userID]
	conns := make([]*Client, 0, len(set))
	for c := range set {
		conns = append(conns, c)
	}
	h.mu.RUnlock()

	delivered := false
	for _, c := range conns {
		select {
		case c.send <- data:
			delivered = true
		default:
			// Slow consumer; drop rather than block the whole hub.
		}
	}
	return delivered
}

// handleInbound authorizes, persists, and relays one envelope from sender.
func (h *Hub) handleInbound(ctx context.Context, sender *Client, env *Envelope) {
	// record-* envelopes are addressed to the server-side recorder bot, not to
	// another user, so they have no "to" and bypass the relay.
	switch env.Type {
	case TypeRecordAnswer, TypeRecordICE:
		if h.OnRecordSignal != nil && env.CallID != "" {
			h.OnRecordSignal(ctx, env.CallID, sender.userID, env.Type, env.Payload)
		}
		return
	case TypeRecordControl:
		h.handleRecordControl(ctx, sender, env)
		return
	}

	if env.To == "" {
		h.sendError(sender, "missing target")
		return
	}
	// Authorize: caller and target must be a valid employer<->employee pair in
	// the same org (god may talk to anyone).
	targetOrg, targetRole, ok := h.lookupUser(ctx, env.To)
	if !ok || !canCommunicate(sender, targetOrg, targetRole) {
		h.sendError(sender, "not allowed")
		return
	}

	env.From = sender.userID // never trust a client-supplied sender

	switch env.Type {
	case TypeCallOffer:
		// The caller generates the call id so both sides share it from the start.
		// Persist the call row under that id (best-effort), then relay + ring.
		h.createCall(ctx, env.CallID, sender.orgID, sender.userID, env.To)
		data, _ := json.Marshal(env)
		h.routeTo(env.To, data)
		// Always fire a push too: it rings a closed PWA, and on an open-but-idle
		// device the service worker can still surface the incoming call.
		if h.OnRing != nil {
			h.OnRing(ctx, env.To, h.displayName(ctx, sender.userID), env.CallID)
		}

	case TypeCallAccept:
		_ = h.markAnswered(ctx, env.CallID)
		// Recording no longer starts automatically — the employer's client opts
		// in via a record-control message (see handleRecordControl).
		h.relay(env)

	case TypeCallReject:
		_ = h.markEnded(ctx, env.CallID, "rejected")
		h.endRecording(env.CallID)
		h.relay(env)

	case TypeCallCancel:
		_ = h.markEnded(ctx, env.CallID, "missed")
		h.endRecording(env.CallID)
		h.relay(env)

	case TypeHangup:
		_ = h.markEnded(ctx, env.CallID, "ended")
		h.endRecording(env.CallID)
		h.relay(env)

	case TypeChat:
		h.persistChat(ctx, sender, env)
		h.relay(env)

	case TypeCallAnswer, TypeICE:
		// Pure media negotiation — relay as-is.
		h.relay(env)

	default:
		h.sendError(sender, "unknown type")
	}
}

func (h *Hub) endRecording(callID string) {
	if h.OnRecordEnd != nil && callID != "" {
		h.OnRecordEnd(callID)
	}
}

// handleRecordControl starts or stops the recorder bot for a call. Only the
// employer (or god) side may control it, and only for a call they're part of.
func (h *Hub) handleRecordControl(ctx context.Context, sender *Client, env *Envelope) {
	if env.CallID == "" {
		return
	}
	if sender.role != models.RoleEmployer && sender.role != models.RoleGod {
		return
	}
	if sender.role != models.RoleGod && !h.isParticipant(ctx, env.CallID, sender.userID) {
		return
	}
	var ctrl struct {
		Enabled bool `json:"enabled"`
	}
	_ = json.Unmarshal(env.Payload, &ctrl)
	if ctrl.Enabled {
		if h.OnRecord != nil {
			h.OnRecord(ctx, env.CallID, sender.orgID)
		}
	} else {
		h.endRecording(env.CallID)
	}
}

// isParticipant reports whether userID is the caller or callee of callID.
func (h *Hub) isParticipant(ctx context.Context, callID, userID string) bool {
	var one int
	err := h.db.QueryRow(ctx,
		`SELECT 1 FROM calls WHERE id = $1 AND (caller_id = $2 OR callee_id = $2)`,
		callID, userID,
	).Scan(&one)
	return err == nil
}

func (h *Hub) relay(env *Envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	h.routeTo(env.To, data)
}

func (h *Hub) sendError(c *Client, msg string) {
	payload, _ := json.Marshal(map[string]string{"message": msg})
	data, _ := json.Marshal(Envelope{Type: TypeError, Payload: payload})
	select {
	case c.send <- data:
	default:
	}
}

// canCommunicate enforces the employer<->employee, same-org rule.
func canCommunicate(sender *Client, targetOrg string, targetRole models.Role) bool {
	if sender.role == models.RoleGod {
		return true
	}
	if sender.orgID == "" || targetOrg == "" || sender.orgID != targetOrg {
		return false
	}
	// Exactly one side must be the employer; no employee<->employee calls.
	return (sender.role == models.RoleEmployer && targetRole == models.RoleEmployee) ||
		(sender.role == models.RoleEmployee && targetRole == models.RoleEmployer)
}

// --- persistence helpers ---

func (h *Hub) lookupUser(ctx context.Context, userID string) (orgID string, role models.Role, ok bool) {
	var org *string
	var r string
	err := h.db.QueryRow(ctx, `SELECT org_id::text, role FROM users WHERE id = $1`, userID).Scan(&org, &r)
	if err != nil {
		return "", "", false
	}
	if org != nil {
		orgID = *org
	}
	return orgID, models.Role(r), true
}

func (h *Hub) displayName(ctx context.Context, userID string) string {
	var name, email string
	if err := h.db.QueryRow(ctx,
		`SELECT COALESCE(full_name,''), email FROM users WHERE id = $1`, userID,
	).Scan(&name, &email); err != nil {
		return "Someone"
	}
	if name != "" {
		return name
	}
	return email
}

// createCall persists a ringing call row. The caller supplies the id (a UUID it
// generated) so both peers share it before any round-trip; a blank id is ignored.
func (h *Hub) createCall(ctx context.Context, callID, orgID, callerID, calleeID string) {
	if callID == "" {
		return
	}
	_, _ = h.db.Exec(ctx,
		`INSERT INTO calls (id, org_id, caller_id, callee_id, status)
		 VALUES ($1,$2,$3,$4,'ringing') ON CONFLICT (id) DO NOTHING`,
		callID, orgID, callerID, calleeID,
	)
}

func (h *Hub) markAnswered(ctx context.Context, callID string) error {
	if callID == "" {
		return nil
	}
	_, err := h.db.Exec(ctx,
		`UPDATE calls SET status='answered', answered_at=NOW() WHERE id=$1 AND answered_at IS NULL`,
		callID,
	)
	return err
}

func (h *Hub) markEnded(ctx context.Context, callID, status string) error {
	if callID == "" {
		return nil
	}
	// "missed"/"rejected" only apply if the call was never answered; an answered
	// call that ends is always "ended" with a computed duration.
	_, err := h.db.Exec(ctx, `
		UPDATE calls
		SET ended_at = NOW(),
		    status = CASE WHEN answered_at IS NULL THEN $2 ELSE 'ended' END,
		    duration_seconds = CASE
		        WHEN answered_at IS NULL THEN 0
		        ELSE GREATEST(0, EXTRACT(EPOCH FROM (NOW() - answered_at))::int)
		    END
		WHERE id = $1 AND ended_at IS NULL`,
		callID, status,
	)
	return err
}

func (h *Hub) persistChat(ctx context.Context, sender *Client, env *Envelope) {
	var body struct {
		Body string `json:"body"`
	}
	_ = json.Unmarshal(env.Payload, &body)
	if body.Body == "" {
		return
	}
	var id string
	var createdAt time.Time
	err := h.db.QueryRow(ctx,
		`INSERT INTO messages (org_id, sender_id, recipient_id, body)
		 VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
		sender.orgID, sender.userID, env.To, body.Body,
	).Scan(&id, &createdAt)
	if err != nil {
		return
	}
	// Echo the stored id/timestamp back into the relayed payload so both sides
	// agree on the canonical message.
	msg := models.Message{Body: body.Body, CreatedAt: createdAt}
	enriched, _ := json.Marshal(map[string]any{
		"id":         id,
		"body":       msg.Body,
		"created_at": createdAt,
	})
	env.Payload = enriched
}
