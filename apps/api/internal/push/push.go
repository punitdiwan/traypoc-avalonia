// Package push sends Web Push (VAPID) notifications so a closed PWA rings on an
// incoming call. It is a no-op unless VAPID keys are configured.
package push

import (
	"context"
	"encoding/json"
	"net/http"
	"os"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Sender struct {
	db      *pgxpool.Pool
	pubKey  string
	privKey string
	subject string
}

func NewSender(db *pgxpool.Pool) *Sender {
	subject := os.Getenv("VAPID_SUBJECT")
	if subject == "" {
		subject = "mailto:admin@example.com"
	}
	return &Sender{
		db:      db,
		pubKey:  os.Getenv("VAPID_PUBLIC_KEY"),
		privKey: os.Getenv("VAPID_PRIVATE_KEY"),
		subject: subject,
	}
}

// Enabled reports whether VAPID keys are configured.
func (s *Sender) Enabled() bool { return s.pubKey != "" && s.privKey != "" }

// RingCall pushes an "incoming-call" notification to every device of calleeID.
// Safe to call from the signaling hub; it swallows errors and prunes dead subs.
func (s *Sender) RingCall(ctx context.Context, calleeID, callerName, callID string) {
	if !s.Enabled() {
		return
	}
	payload, _ := json.Marshal(map[string]string{
		"type":    "incoming-call",
		"caller":  callerName,
		"call_id": callID,
	})
	s.fanOut(ctx, calleeID, payload)
}

// RingMessage pushes a "new-message" notification to every device of
// recipientID. The service worker surfaces it as a system notification when the
// PWA is closed/backgrounded, or hands it to an open app for an in-app toast.
// This is what gives the employer a background alert when an employee writes
// while they aren't looking at the chat. Safe to call inline; swallows errors.
func (s *Sender) RingMessage(ctx context.Context, recipientID, senderID, senderName, msgID, preview string) {
	if !s.Enabled() {
		return
	}
	payload, _ := json.Marshal(map[string]string{
		"type": "new-message",
		"from": senderID,
		"name": senderName,
		"id":   msgID,
		"body": preview,
	})
	s.fanOut(ctx, recipientID, payload)
}

// fanOut delivers a payload to all of a user's push subscriptions.
func (s *Sender) fanOut(ctx context.Context, userID string, payload []byte) {
	rows, err := s.db.Query(ctx,
		`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, userID)
	if err != nil {
		return
	}
	type sub struct{ endpoint, p256dh, auth string }
	var subs []sub
	for rows.Next() {
		var x sub
		if err := rows.Scan(&x.endpoint, &x.p256dh, &x.auth); err == nil {
			subs = append(subs, x)
		}
	}
	rows.Close()
	for _, x := range subs {
		s.send(ctx, x.endpoint, x.p256dh, x.auth, payload)
	}
}

func (s *Sender) send(ctx context.Context, endpoint, p256dh, auth string, payload []byte) {
	resp, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: endpoint,
		Keys:     webpush.Keys{P256dh: p256dh, Auth: auth},
	}, &webpush.Options{
		Subscriber:      s.subject,
		VAPIDPublicKey:  s.pubKey,
		VAPIDPrivateKey: s.privKey,
		TTL:             30,
		Urgency:         webpush.UrgencyHigh,
	})
	if err != nil || resp == nil {
		return
	}
	defer resp.Body.Close()
	// Prune subscriptions the push service has expired/removed.
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		_, _ = s.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE endpoint = $1`, endpoint)
	}
}
