package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"time-tracker/api/internal/auth"
	"time-tracker/api/internal/models"
)

const (
	writeWait  = 10 * time.Second
	pingPeriod = 30 * time.Second
	sendBuffer = 32
)

// ServeWS upgrades the request to a WebSocket and runs the read/write pumps.
//
// Browsers cannot set an Authorization header on a WebSocket handshake, so the
// access token is passed as the `token` query parameter. The token is the real
// authorization gate, so we accept any Origin (the handshake itself carries no
// ambient credentials).
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	tokenStr := r.URL.Query().Get("token")
	claims, err := auth.ValidateAccessToken(tokenStr)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Non-god users must belong to an org to call/chat.
	if claims.Role != models.RoleGod && claims.OrgID == "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"}, // JWT in the query is the gate
	})
	if err != nil {
		return
	}

	client := &Client{
		userID: claims.UserID,
		orgID:  claims.OrgID,
		role:   claims.Role,
		send:   make(chan []byte, sendBuffer),
	}
	h.register(client)

	// A connection-scoped context so both pumps stop when either ends.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer h.unregister(client)
	defer conn.Close(websocket.StatusNormalClosure, "")

	go h.writePump(ctx, conn, client)
	h.readPump(ctx, conn, client)
}

func (h *Hub) readPump(ctx context.Context, conn *websocket.Conn, client *Client) {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var env Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			h.sendError(client, "bad json")
			continue
		}
		// Persist/relay off the read goroutine's hot path but bounded by ctx.
		h.handleInbound(ctx, client, &env)
	}
}

func (h *Hub) writePump(ctx context.Context, conn *websocket.Conn, client *Client) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case data := <-client.send:
			wctx, cancel := context.WithTimeout(ctx, writeWait)
			err := conn.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			pctx, cancel := context.WithTimeout(ctx, writeWait)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}
