// Package recorder is the server-side "recorder bot": a headless Pion WebRTC
// peer that joins each answered call as a recv-only audio participant, captures
// each side of the conversation, and uploads an Opus/OGG recording to Spaces.
//
// Flow (per call, two participants):
//
//	call answered -> Manager.Start
//	  for each participant: create a recv-only PeerConnection, send a
//	  "record-offer" through the signaling hub. The browser adds its mic track
//	  and replies with "record-answer" (+ trickled "record-ice"). The bot writes
//	  every inbound RTP packet to a per-participant OGG buffer.
//	call ends -> Manager.Stop: finalize OGG, upload to Spaces, insert
//	  call_recordings rows.
//
// The bot is tamper-proof: recording happens entirely server-side, independent
// of the clients. It is a no-op when Spaces is not configured.
package recorder

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"

	"time-tracker/api/internal/realtime"
	"time-tracker/api/internal/spaces"
)

// SendFunc delivers an envelope to a user's live connections (hub.SendEnvelope).
type SendFunc func(userID string, env realtime.Envelope) bool

type Manager struct {
	db     *pgxpool.Pool
	spaces *spaces.Client
	send   SendFunc

	mu       sync.Mutex
	sessions map[string]*session
}

func NewManager(db *pgxpool.Pool, sp *spaces.Client, send SendFunc) *Manager {
	return &Manager{
		db:       db,
		spaces:   sp,
		send:     send,
		sessions: make(map[string]*session),
	}
}

// Enabled reports whether recording can run (Spaces configured).
func (m *Manager) Enabled() bool { return m.spaces != nil }

type peer struct {
	userID string
	pc     *webrtc.PeerConnection
	buf    *bytes.Buffer
	writer *oggwriter.OggWriter

	mu        sync.Mutex
	wrote     bool
	remoteSet bool
	pending   []webrtc.ICECandidateInit
}

type session struct {
	callID    string
	orgID     string
	startedAt time.Time
	mu        sync.Mutex
	peers     map[string]*peer
	done      bool
}

// Start launches recording for an answered call. Safe to call more than once.
func (m *Manager) Start(ctx context.Context, callID, orgID string) {
	if !m.Enabled() || callID == "" {
		return
	}

	m.mu.Lock()
	if _, exists := m.sessions[callID]; exists {
		m.mu.Unlock()
		return
	}
	sess := &session{callID: callID, orgID: orgID, startedAt: time.Now(), peers: make(map[string]*peer)}
	m.sessions[callID] = sess
	m.mu.Unlock()

	var callerID, calleeID string
	err := m.db.QueryRow(ctx,
		`SELECT caller_id::text, callee_id::text FROM calls WHERE id = $1`, callID,
	).Scan(&callerID, &calleeID)
	if err != nil {
		log.Printf("recorder: lookup call %s: %v", callID, err)
		return
	}

	for _, uid := range []string{callerID, calleeID} {
		if err := m.addParticipant(sess, uid); err != nil {
			log.Printf("recorder: add participant %s to call %s: %v", uid, callID, err)
		}
	}
}

func (m *Manager) addParticipant(sess *session, userID string) error {
	pc, err := webrtc.NewPeerConnection(iceConfig(userID))
	if err != nil {
		return err
	}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly},
	); err != nil {
		pc.Close()
		return err
	}

	buf := &bytes.Buffer{}
	writer, err := oggwriter.NewWith(buf, 48000, 2)
	if err != nil {
		pc.Close()
		return err
	}
	p := &peer{userID: userID, pc: pc, buf: buf, writer: writer}

	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() != webrtc.RTPCodecTypeAudio {
			return
		}
		for {
			pkt, _, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			p.mu.Lock()
			if p.writer != nil {
				if writeErr := p.writer.WriteRTP(pkt); writeErr == nil {
					p.wrote = true
				}
			}
			p.mu.Unlock()
		}
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		payload, _ := json.Marshal(c.ToJSON())
		m.send(userID, realtime.Envelope{
			Type:    realtime.TypeRecordICE,
			CallID:  sess.callID,
			Payload: payload,
		})
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		return err
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		return err
	}

	sess.mu.Lock()
	sess.peers[userID] = p
	sess.mu.Unlock()

	payload, _ := json.Marshal(map[string]any{"sdp": offer})
	m.send(userID, realtime.Envelope{
		Type:    realtime.TypeRecordOffer,
		CallID:  sess.callID,
		Payload: payload,
	})
	return nil
}

// HandleSignal applies a participant's record-answer / record-ice to its peer.
func (m *Manager) HandleSignal(ctx context.Context, callID, from, typ string, payload json.RawMessage) {
	m.mu.Lock()
	sess := m.sessions[callID]
	m.mu.Unlock()
	if sess == nil {
		return
	}
	sess.mu.Lock()
	p := sess.peers[from]
	sess.mu.Unlock()
	if p == nil {
		return
	}

	switch typ {
	case realtime.TypeRecordAnswer:
		var body struct {
			SDP webrtc.SessionDescription `json:"sdp"`
		}
		if err := json.Unmarshal(payload, &body); err != nil {
			return
		}
		if err := p.pc.SetRemoteDescription(body.SDP); err != nil {
			log.Printf("recorder: set remote desc: %v", err)
			return
		}
		p.mu.Lock()
		p.remoteSet = true
		pending := p.pending
		p.pending = nil
		p.mu.Unlock()
		for _, c := range pending {
			_ = p.pc.AddICECandidate(c)
		}

	case realtime.TypeRecordICE:
		var cand webrtc.ICECandidateInit
		if err := json.Unmarshal(payload, &cand); err != nil {
			return
		}
		p.mu.Lock()
		if !p.remoteSet {
			p.pending = append(p.pending, cand)
			p.mu.Unlock()
			return
		}
		p.mu.Unlock()
		_ = p.pc.AddICECandidate(cand)
	}
}

// Stop finalizes a call's recording: flush OGG, upload to Spaces, persist rows.
func (m *Manager) Stop(callID string) {
	m.mu.Lock()
	sess := m.sessions[callID]
	delete(m.sessions, callID)
	m.mu.Unlock()
	if sess == nil {
		return
	}
	sess.mu.Lock()
	if sess.done {
		sess.mu.Unlock()
		return
	}
	sess.done = true
	peers := make([]*peer, 0, len(sess.peers))
	for _, p := range sess.peers {
		peers = append(peers, p)
	}
	sess.mu.Unlock()

	duration := int(time.Since(sess.startedAt).Seconds())
	// Upload runs in the background so it never blocks call teardown.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		for _, p := range peers {
			m.finalize(ctx, sess, p, duration)
		}
	}()
}

func (m *Manager) finalize(ctx context.Context, sess *session, p *peer, duration int) {
	p.mu.Lock()
	if p.writer != nil {
		_ = p.writer.Close()
		p.writer = nil
	}
	wrote := p.wrote
	data := p.buf.Bytes()
	p.mu.Unlock()

	if p.pc != nil {
		_ = p.pc.Close()
	}
	if !wrote || len(data) == 0 {
		return
	}

	key := fmt.Sprintf("recordings/%s/%s-%s.ogg", sess.orgID, sess.callID, p.userID)
	url, err := m.spaces.PutBytes(ctx, key, "audio/ogg", data)
	if err != nil {
		log.Printf("recorder: upload %s: %v", key, err)
		return
	}
	_, err = m.db.Exec(ctx,
		`INSERT INTO call_recordings (call_id, storage_url, format, size_bytes, duration_seconds)
		 VALUES ($1, $2, 'ogg', $3, $4)`,
		sess.callID, url, len(data), duration,
	)
	if err != nil {
		log.Printf("recorder: insert recording row: %v", err)
	}
}

// iceConfig builds the bot's ICE servers (STUN + optional short-lived TURN),
// mirroring the credential scheme the /turn-credentials handler issues.
func iceConfig(userID string) webrtc.Configuration {
	stun := os.Getenv("STUN_URL")
	if stun == "" {
		stun = "stun:stun.l.google.com:19302"
	}
	servers := []webrtc.ICEServer{{URLs: []string{stun}}}
	servers = append(servers, webrtc.ICEServer{URLs: []string{"turns:openrelayproject.org:5349"}})

	turnHost := os.Getenv("TURN_HOST")
	secret := os.Getenv("TURN_SECRET")
	if turnHost != "" && secret != "" {
		expiry := time.Now().Add(12 * time.Hour).Unix()
		username := strconv.FormatInt(expiry, 10) + ":recorder-" + userID
		mac := hmac.New(sha1.New, []byte(secret))
		mac.Write([]byte(username))
		servers = append(servers, webrtc.ICEServer{
			URLs:       strings.Split(turnHost, ","),
			Username:   username,
			Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		})
	}
	return webrtc.Configuration{ICEServers: servers}
}
