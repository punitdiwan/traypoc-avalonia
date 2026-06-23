// Single authenticated WebSocket to the signaling hub (calls + chat).
//
// Reconnects with backoff and re-auths with the current access token on each
// connect. Consumers subscribe to typed envelopes; the call/chat layers build on
// top of this.

export type EnvelopeType =
  | "call-offer"
  | "call-answer"
  | "ice-candidate"
  | "call-accept"
  | "call-reject"
  | "call-cancel"
  | "hangup"
  | "chat-message"
  | "error"
  | "presence"
  // Recorder-bot signaling (server-side recording peer).
  | "record-offer"
  | "record-answer"
  | "record-ice"
  // Admin (employer) toggles server-side recording on/off for the call.
  | "record-control";

export interface Envelope {
  type: EnvelopeType;
  to?: string;
  from?: string;
  call_id?: string;
  // SDP / ICE / chat body — opaque to the relay.
  payload?: unknown;
}

type Handler = (env: Envelope) => void;

function wsUrl(token: string): string {
  // WebSockets can't ride the Vercel rewrite, so in production point straight at
  // the API origin (VITE_API_ORIGIN, e.g. https://timetrackerapi.maitretech.com).
  // In dev it's unset and we use the Vite proxy via location.host.
  const apiOrigin = import.meta.env.VITE_API_ORIGIN as string | undefined;
  if (apiOrigin) {
    const wsOrigin = apiOrigin.replace(/^http/, "ws"); // https->wss, http->ws
    return `${wsOrigin}/ws?token=${encodeURIComponent(token)}`;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}

class Realtime {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private backoff = 1000;
  private closedByUs = false;
  private connecting = false;

  /** Open (or re-open) the connection. Idempotent. */
  connect() {
    if (this.connecting || this.ws?.readyState === WebSocket.OPEN) return;
    const token = localStorage.getItem("access_token");
    if (!token) return;
    this.closedByUs = false;
    this.connecting = true;

    const ws = new WebSocket(wsUrl(token));
    this.ws = ws;

    ws.onopen = () => {
      this.connecting = false;
      this.backoff = 1000;
    };
    ws.onmessage = (e) => {
      let env: Envelope;
      try {
        env = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handlers.forEach((h) => h(env));
    };
    ws.onclose = () => {
      this.connecting = false;
      this.ws = null;
      if (!this.closedByUs) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  disconnect() {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }

  send(env: Envelope): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(env));
    return true;
  }

  /** Subscribe to all inbound envelopes; returns an unsubscribe fn. */
  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export const realtime = new Realtime();
