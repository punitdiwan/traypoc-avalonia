# LiveKit deployment (voice calls)

This replaces the legacy peer-to-peer mesh + Pion recorder bot: calls now run
over a self-hosted LiveKit SFU. The signaling WebSocket (`/ws` on the API) is
still used to ring the callee; only the media path moved to LiveKit.

## What runs where

| Piece | Where | Notes |
|-------|-------|-------|
| `livekit-server` | this VPS, host network | signaling on `:7880`, media on udp `50000-50100` + tcp `7881` |
| `redis` | this VPS, `127.0.0.1:6379` | node store; required for egress |
| `egress` (optional) | this VPS, host network | Chromium room recorder → DO Spaces |
| API | existing api container | mints LiveKit JWTs + drives egress |
| web | Vercel | `livekit-client` connects to `wss://livekit.<domain>` |

## 1. Generate an API key/secret

```bash
export LIVEKIT_API_KEY=$(openssl rand -hex 8)
export LIVEKIT_API_SECRET=$(openssl rand -hex 24)
echo "$LIVEKIT_API_KEY / $LIVEKIT_API_SECRET"   # save these
```

The **same pair** goes into three places: the compose env above, `apps/api/.env`
(`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`), and — if recording — `egress.yaml`.

## 2. DNS + firewall

- Point `livekit.<domain>` (e.g. `livekit.maitretech.com`) at the VPS.
- Open on the firewall: **udp 50000-50100** and **tcp 7881** (media), plus 443
  (nginx). Do **not** expose 7880 publicly — nginx proxies it.

## 3. Host nginx — terminate TLS, proxy the WebSocket

```nginx
server {
    listen 443 ssl;
    server_name livekit.maitretech.com;
    # ssl_certificate ... (certbot / your existing cert setup)

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;   # keep long-lived WS alive
    }
}
```

## 4. Start LiveKit

```bash
docker compose -f docker/livekit/docker-compose.yml up -d
docker compose -f docker/livekit/docker-compose.yml --profile recording up -d   # to include recording
docker stats livekit                      # idle ~13 MiB
```

## 5. Point the API + web at it

`apps/api/.env`:

```ini
LIVEKIT_URL=wss://livekit.maitretech.com
LIVEKIT_API_KEY=...        # the pair from step 1
LIVEKIT_API_SECRET=...
LIVEKIT_RECORD=            # set to 1 only after basic calls work + egress is up
```

Vercel env for the web app: `VITE_LIVEKIT` is **not** needed — the browser gets
the `wss://` URL from the API's `/livekit/token` response. (Make sure the API is
redeployed with the new env, and the web app rebuilt against the new
`livekit-client` dependency.)

Restart the API; it logs `LiveKit calls enabled (wss://…)` on boot. When
`LIVEKIT_*` is unset the API automatically falls back to the legacy mesh path, so
this is safe to roll out incrementally.

## Verify

1. Two browsers (employer + employee), employer clicks **Call**.
2. `docker logs -f livekit` shows a room created and two participants joining.
3. With recording on, an `.ogg` lands at
   `call-recordings/<call_id>.ogg` in the Spaces bucket and a `call_recordings`
   row points at it.

## Notes / gotchas

- Recording uses **room-composite** egress (audio-only OGG). It launches headless
  Chromium, so the egress container is heavier than the server — enable it only
  when you actually want recordings.
- The recording `call_recordings` row is inserted when recording starts; the file
  appears after the call ends and egress finalizes (a few seconds). For robust
  status tracking, wire LiveKit's egress webhook later (phase 2).
- `redis` runs on host networking bound to `127.0.0.1`; if the VPS already runs a
  Redis on 6379, point both `livekit.yaml` and `egress.yaml` at that instead and
  drop this service.
