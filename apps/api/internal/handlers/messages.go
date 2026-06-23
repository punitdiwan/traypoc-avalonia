package handlers

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	mw "time-tracker/api/internal/middleware"
	"time-tracker/api/internal/models"
)

type MessageHandler struct {
	db *pgxpool.Pool
}

func NewMessageHandler(db *pgxpool.Pool) *MessageHandler {
	return &MessageHandler{db: db}
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
