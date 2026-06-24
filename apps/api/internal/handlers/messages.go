package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
	"time-tracker/api/internal/push"
)

type MessageHandler struct {
	db   *pgxpool.Pool
	push *push.Sender
}

func NewMessageHandler(db *pgxpool.Pool, pushSender *push.Sender) *MessageHandler {
	return &MessageHandler{db: db, push: pushSender}
}

// List returns the chat history between the caller and the ?with= user, oldest
// first (so the UI can append). Both users must share the caller's org. As a
// side effect it marks messages addressed to the caller as read.
func (h *MessageHandler) List(w http.ResponseWriter, r *http.Request) {
	me := mw.UserID(r)
	other := r.URL.Query().Get("with")
	if other == "" {
		http.Error(w, "missing with", http.StatusBadRequest)
		return
	}

	// Authorization: the other user must be in the caller's org (god exempt).
	if !mw.IsGod(r) {
		var sameOrg bool
		err := h.db.QueryRow(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND org_id = $2)`,
			other, mw.OrgID(r),
		).Scan(&sameOrg)
		if err != nil || !sameOrg {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
	}

	rows, err := h.db.Query(r.Context(), `
		SELECT id, org_id, sender_id, recipient_id, body, created_at, read_at
		FROM messages
		WHERE (sender_id = $1 AND recipient_id = $2)
		   OR (sender_id = $2 AND recipient_id = $1)
		ORDER BY created_at ASC
		LIMIT 500`,
		me, other,
	)
	if err != nil {
		http.Error(w, "query error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	result := []models.Message{}
	for rows.Next() {
		var m models.Message
		if err := rows.Scan(&m.ID, &m.OrgID, &m.SenderID, &m.RecipientID, &m.Body, &m.CreatedAt, &m.ReadAt); err != nil {
			continue
		}
		result = append(result, m)
	}

	// Mark anything the other side sent us as read.
	_, _ = h.db.Exec(r.Context(),
		`UPDATE messages SET read_at = NOW() WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
		me, other,
	)

	writeJSON(w, result)
}

// Create persists a chat message from the caller to {to}. Realtime delivery rides
// LiveKit data messaging on the client; this endpoint is the durable history +
// authorization gate. The same employer<->employee, same-org rule as calls applies
// (god exempt). Returns the stored row (canonical id/timestamp) so the sender can
// broadcast it over LiveKit and both sides agree on the message.
func (h *MessageHandler) Create(w http.ResponseWriter, r *http.Request) {
	me := mw.UserID(r)

	var in struct {
		To   string `json:"to"`
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.To == "" || in.Body == "" {
		http.Error(w, "missing to/body", http.StatusBadRequest)
		return
	}

	// Authorize the pair: target must share the caller's org and be the opposite
	// side of the employer<->employee relationship (god may message anyone).
	var otherOrg *string
	var otherRole string
	if err := h.db.QueryRow(r.Context(),
		`SELECT org_id::text, role FROM users WHERE id = $1`, in.To,
	).Scan(&otherOrg, &otherRole); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	myRole := mw.Role(r)
	orgID := mw.OrgID(r)
	if !mw.IsGod(r) {
		validPair := (myRole == models.RoleEmployer && models.Role(otherRole) == models.RoleEmployee) ||
			(myRole == models.RoleEmployee && models.Role(otherRole) == models.RoleEmployer)
		if orgID == "" || otherOrg == nil || *otherOrg != orgID || !validPair {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
	}
	if orgID == "" && otherOrg != nil {
		orgID = *otherOrg // god has no org of their own; file under the target's
	}

	var m models.Message
	if err := h.db.QueryRow(r.Context(),
		`INSERT INTO messages (org_id, sender_id, recipient_id, body)
		 VALUES ($1,$2,$3,$4)
		 RETURNING id, org_id, sender_id, recipient_id, body, created_at, read_at`,
		orgID, me, in.To, in.Body,
	).Scan(&m.ID, &m.OrgID, &m.SenderID, &m.RecipientID, &m.Body, &m.CreatedAt, &m.ReadAt); err != nil {
		http.Error(w, "insert error", http.StatusInternalServerError)
		return
	}

	// Background alert: push the message to the recipient's devices. The service
	// worker shows a system notification when their PWA is closed/backgrounded, or
	// hands it to an open app for an in-app toast (e.g. an employer whose chat
	// drawer is closed). Realtime delivery to an open conversation still rides
	// LiveKit; this is purely the "you have a new message" nudge.
	if h.push != nil {
		preview := in.Body
		if len(preview) > 120 {
			preview = preview[:120]
		}
		h.push.RingMessage(r.Context(), in.To, me, h.senderName(r, me), m.ID.String(), preview)
	}

	writeJSON(w, m)
}

// senderName resolves a display name for the message sender (full name, else email).
func (h *MessageHandler) senderName(r *http.Request, userID string) string {
	var name, email string
	if err := h.db.QueryRow(r.Context(),
		`SELECT COALESCE(full_name,''), email FROM users WHERE id = $1`, userID,
	).Scan(&name, &email); err != nil {
		return "Someone"
	}
	if name != "" {
		return name
	}
	return email
}

// Admin returns the primary employer of the caller's org, so an employee's chat UI
// knows who to address ("Message Admin"). The oldest employer is treated as the
// owner. Employer/god callers don't need this.
func (h *MessageHandler) Admin(w http.ResponseWriter, r *http.Request) {
	org := mw.OrgID(r)
	if org == "" {
		http.Error(w, "no org", http.StatusNotFound)
		return
	}
	var id, name, email string
	if err := h.db.QueryRow(r.Context(),
		`SELECT id::text, COALESCE(full_name,''), email
		 FROM users WHERE org_id = $1 AND role = 'employer'
		 ORDER BY created_at ASC LIMIT 1`,
		org,
	).Scan(&id, &name, &email); err != nil {
		http.Error(w, "no admin", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"id": id, "full_name": name, "email": email})
}
