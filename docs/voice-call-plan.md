# Voice Call + Messaging + Server Recording — Implementation Plan

PWA, Android-first, self-built. Employer calls/messages employees; calls are recorded
server-side to DigitalOcean Spaces.

## Locked decisions
- **Self-built** (no ConnectyCube/CPaaS).
- **PWA** — installable on Android, no Capacitor, no app store, no Apple account.
- **Calling:** WebRTC P2P **audio** + **text chat**, employer → employee, org-scoped.
- **Ringing:** **Web Push (VAPID)** notification with sound → tap to answer. When the app is
  open, the WebSocket delivers an instant in-app ring.
- **Recording:** **Pion recorder bot** (server-side, Go) mixes both parties → uploads to
  **DO Spaces**. Tamper-proof, independent of the clients.
- **Mobile-friendly** responsive pass on the web app.

> Accepted trade-off: without a native app there is **no full-screen lock-screen ring** — it is
> a notification with sound the employee taps to answer. Instant ring is guaranteed only while
> the app is open (WebSocket). iOS is out of scope for v1 (would later need Capacitor + an Apple
> Developer account; the backend stays unchanged).

## Architecture
```
 Employer (PWA)                                  Employee (PWA on Android)
      |  WebSocket /ws (SDP/ICE/chat, JWT)              ^
      v                                                 | Web Push (closed) / WS (open)
 +--------------------------------------------------------------------+
 |  Go API (chi)                                                      |
 |  - WS signaling hub (Redis pub/sub)                               |
 |  - Call lifecycle -> Web Push (VAPID) to wake/ring callee         |
 |  - TURN credential issuer                                         |
 |  - REST: calls / messages / recordings / push-subscribe          |
 +-------+-------------------------------+---------------------------+
         | spawns per call               |
         v                               v
   +-------------+                 +------------+
   | Pion bot    |<---- audio -----| coturn TURN|<-- media relay (mesh: peer<->peer<->bot)
   | mix+encode  |                 +------------+
   | -> DO Spaces|
   +-------------+
```
Call media is a **3-peer mesh**: employer <-> employee for the live conversation, and both also
send audio to the Pion bot for recording. TURN relays media when a direct connection fails
(always needed on mobile networks).

## Infrastructure prerequisites
1. **HTTPS + domain** for web + API (mandatory — service worker, mic, WebRTC, push all require it).
2. **coturn** TURN server (droplet) with short-lived HMAC credentials.
3. **VAPID keys** for Web Push (self-generated; no Firebase needed).
4. New env: `TURN_HOST/TURN_SECRET`, `VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY`, existing `DO_SPACES_*`.

## Backend (Go — `apps/api`)
- **Deps:** `coder/websocket` (signaling), `pion/webrtc/v4` (+ Opus/ogg writer) for the bot,
  `SherClockHolmes/webpush-go` for Web Push.
- **`internal/realtime/hub.go`** — `GET /ws` (JWT via query param), org-scoped hub, Redis
  pub/sub for multi-instance. Messages: `call-offer/answer/ice/accept/reject/cancel/hangup/chat-message`.
- **`internal/handlers/calls.go`** — call lifecycle; on offer, relay over WS **and** send Web
  Push to ring a closed app; write `calls` rows; `GET /calls` history.
- **`internal/recorder/bot.go`** — Pion peer joins each accepted call, receives both Opus
  tracks, mixes/encodes, uploads to Spaces (reuse `internal/spaces`), writes `call_recordings`.
  Optional asynq post-processing.
- **`internal/handlers/turn.go`** — `GET /turn-credentials` (short-lived).
- **`internal/handlers/messages.go`** — `GET /messages?with=`, live via WS, persisted.
- **`internal/push/`** — VAPID Web Push sender; `POST /push/subscribe`.
- **Migrations** (inline in `db.go`): `calls`, `call_recordings`, `messages`,
  `push_subscriptions` — all org/role-scoped. **Test on local throwaway Postgres first
  (prod DB is shared/live).**

## Frontend (React — `apps/web`)
- **PWA:** `vite-plugin-pwa` — manifest (name, icons 192/512/maskable), service worker
  (precache shell, **never cache `/api` or WS**), update toast, Android `beforeinstallprompt`
  install button.
- **Service worker push handler:** show incoming-call notification with sound + Accept/Decline
  actions; click focuses/opens the app into the call.
- **`lib/realtime.ts`** — single authed WebSocket (reconnect/backoff, ICE-restart on
  Wi-Fi<->cellular).
- **`lib/call.ts` + context** — `RTCPeerConnection`(s), mic stream, state machine
  (idle->ringing->connected->ended), adds recorder bot peer.
- **`lib/turn.ts`** — fetch TURN creds per call.
- **UI:** `CallButton`/`MessageButton` per employee; `Incoming/OutgoingCallModal`, `InCallBar`
  (mute/hangup/timer), `ChatDrawer`.
- **Mobile-friendly pass:** wrap wide tables (Diary/Reports/Timesheets/Manage/Invoice) in
  scroll/stack layouts, finish NavBar collapse, >=44px touch targets, test on real Android Chrome.

## Data model (Postgres)
- `calls(id, org_id, caller_id, callee_id, status, started_at, answered_at, ended_at, duration_seconds)`
  — status: ringing/answered/missed/rejected/failed.
- `call_recordings(id, call_id, storage_url, format, size_bytes, duration_seconds, created_at)`
- `messages(id, org_id, sender_id, recipient_id, body, created_at, read_at)`
- `push_subscriptions(id, user_id, endpoint, p256dh, auth, created_at)`

## New API endpoints
- `GET /ws` — authenticated WebSocket (signaling + chat).
- `GET /calls?user_id=&from=&to=` — history (employer any org member; employee own).
- `GET /messages?with={userId}` — chat history.
- `POST /push/subscribe` — register a Web Push subscription.
- `GET /turn-credentials` — short-lived TURN creds.
- `POST /recordings` (+ presign reuse) / bot writes `call_recordings`.

## Phasing & effort
| Phase | Scope | Est. |
|---|---|---|
| 0 | HTTPS + domain, coturn, VAPID keys | 1-2 days |
| 1 | WS signaling + chat + `messages` + chat UI | 4-6 days |
| 2 | P2P audio call + TURN + call UI | 5-7 days |
| 3 | Pion recorder bot -> Spaces + `calls`/`call_recordings` | 5-8 days |
| 4 | PWA (manifest/SW/install) + Web Push ring | 3-5 days |
| 5 | Mobile-responsive pass | 3-5 days |

## Key risks
1. **No full-screen ring** without a native app — tap-to-answer notification (accepted).
2. **Web Push reliability** when fully closed varies by Android OEM battery settings; instant
   ring guaranteed only when the app is open (WS).
3. **TURN is mandatory** for mobile-network calls.
4. **Recording consent** — show an in-call indicator; handle legal/consent before launch.
5. **Prod DB shared/live** — migrate carefully; test locally first.
6. iOS later = add Capacitor + Apple account (backend unchanged).

## Authorization
- WS auth via JWT; every signaling/chat message re-checked for org membership + role
  (employer <-> employee only).
- TURN creds short-lived/HMAC; recordings stored under org-scoped Spaces paths;
  `call_recordings` access enforced like invoices (employer any org member, employee own).
