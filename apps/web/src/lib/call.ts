// WebRTC 1:1 audio call manager, layered on the signaling WebSocket.
//
// Caller flow:  startCall() -> send call-offer (with a fresh call_id + SDP)
//               <- call-accept (SDP answer) -> connected
// Callee flow:  receive call-offer -> state "incoming"
//               accept() -> send call-accept (SDP answer) -> connected
//
// ICE candidates trickle both ways as "ice-candidate". hangup/reject/cancel end
// the call and tear down the peer connection.

import { callsApi, type IceServer } from "./api";
import { realtime, type Envelope } from "./realtime";

export type CallState =
  | "idle"
  | "calling" // outgoing, awaiting answer
  | "incoming" // ringing, awaiting our accept
  | "connecting"
  | "connected"
  | "ended";

export interface CallInfo {
  callId: string;
  peerId: string;
  peerName: string;
  outgoing: boolean;
}

type Listener = () => void;

class CallManager {
  state: CallState = "idle";
  info: CallInfo | null = null;
  muted = false;
  startedAt = 0;

  private pc: RTCPeerConnection | null = null;
  // Separate peer connection to the server-side recorder bot (send-only mic).
  private recordPc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null;
  private pendingOffer: RTCSessionDescriptionInit | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private listeners = new Set<Listener>();
  private unsub: (() => void) | null = null;

  /** Begin listening for inbound signaling. Call once after login. */
  init() {
    if (this.unsub) return;
    realtime.connect();
    this.unsub = realtime.on((env) => this.onSignal(env));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private async iceServers(): Promise<IceServer[]> {
    try {
      const { ice_servers } = await callsApi.iceServers();
      return ice_servers;
    } catch {
      return [{ urls: ["stun:stun.l.google.com:19302"] }];
    }
  }

  private async newPeer(peerId: string, callId: string): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection({ iceServers: await this.iceServers() });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        realtime.send({
          type: "ice-candidate",
          to: peerId,
          call_id: callId,
          payload: e.candidate.toJSON(),
        });
      }
    };
    pc.ontrack = (e) => {
      this.remoteStream = e.streams[0];
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        this.state = "connected";
        if (!this.startedAt) this.startedAt = Date.now();
        this.emit();
      } else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        if (this.state !== "ended") this.cleanup("ended");
      }
    };
    return pc;
  }

  private async getMic(): Promise<MediaStream> {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return this.localStream;
  }

  /** Outgoing call to a peer user. */
  async startCall(peerId: string, peerName: string) {
    if (this.state !== "idle" && this.state !== "ended") return;
    const callId = crypto.randomUUID();
    this.info = { callId, peerId, peerName, outgoing: true };
    this.state = "calling";
    this.startedAt = 0;
    this.emit();

    const stream = await this.getMic();
    this.pc = await this.newPeer(peerId, callId);
    stream.getTracks().forEach((t) => this.pc!.addTrack(t, stream));

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    realtime.send({ type: "call-offer", to: peerId, call_id: callId, payload: { sdp: offer } });
  }

  /** Accept an incoming call. */
  async accept() {
    if (this.state !== "incoming" || !this.info || !this.pendingOffer) return;
    this.state = "connecting";
    this.emit();

    const stream = await this.getMic();
    this.pc = await this.newPeer(this.info.peerId, this.info.callId);
    stream.getTracks().forEach((t) => this.pc!.addTrack(t, stream));

    await this.pc.setRemoteDescription(this.pendingOffer);
    for (const c of this.pendingCandidates) await this.pc.addIceCandidate(c).catch(() => {});
    this.pendingCandidates = [];

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    realtime.send({
      type: "call-accept",
      to: this.info.peerId,
      call_id: this.info.callId,
      payload: { sdp: answer },
    });
  }

  /** Reject an incoming call. */
  reject() {
    if (this.info) {
      realtime.send({ type: "call-reject", to: this.info.peerId, call_id: this.info.callId });
    }
    this.cleanup("ended");
  }

  /** Hang up an active or outgoing call. */
  hangup() {
    if (this.info) {
      const type = this.state === "calling" ? "call-cancel" : "hangup";
      realtime.send({ type, to: this.info.peerId, call_id: this.info.callId });
    }
    this.cleanup("ended");
  }

  toggleMute() {
    this.muted = !this.muted;
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this.emit();
  }

  private cleanup(state: CallState) {
    this.pc?.close();
    this.pc = null;
    this.recordPc?.close();
    this.recordPc = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.remoteStream = null;
    this.pendingOffer = null;
    this.pendingCandidates = [];
    this.muted = false;
    this.startedAt = 0;
    this.state = state;
    this.emit();
    // Return to idle shortly so UI can show an "ended" flash.
    setTimeout(() => {
      if (this.state === state && state === "ended") {
        this.state = "idle";
        this.info = null;
        this.emit();
      }
    }, 1500);
  }

  private async onSignal(env: Envelope) {
    const p = env.payload as { sdp?: RTCSessionDescriptionInit } & RTCIceCandidateInit;
    switch (env.type) {
      case "call-offer": {
        // Busy or mid-call: auto-reject.
        if (this.state !== "idle" && this.state !== "ended") {
          realtime.send({ type: "call-reject", to: env.from, call_id: env.call_id });
          return;
        }
        this.info = {
          callId: env.call_id || "",
          peerId: env.from || "",
          peerName: "Incoming call",
          outgoing: false,
        };
        this.pendingOffer = p?.sdp || null;
        this.state = "incoming";
        this.emit();
        break;
      }
      case "call-accept": {
        if (this.pc && p?.sdp) {
          await this.pc.setRemoteDescription(p.sdp);
          this.state = "connecting";
          this.emit();
        }
        break;
      }
      case "ice-candidate": {
        const cand = env.payload as RTCIceCandidateInit;
        if (this.pc && this.pc.remoteDescription) {
          await this.pc.addIceCandidate(cand).catch(() => {});
        } else if (cand) {
          this.pendingCandidates.push(cand);
        }
        break;
      }
      case "call-reject":
      case "call-cancel":
      case "hangup": {
        if (env.call_id && this.info && env.call_id === this.info.callId) {
          this.cleanup("ended");
        }
        break;
      }
      case "record-offer": {
        await this.onRecordOffer(env);
        break;
      }
      case "record-ice": {
        const cand = (env.payload as RTCIceCandidateInit);
        if (this.recordPc && cand) await this.recordPc.addIceCandidate(cand).catch(() => {});
        break;
      }
    }
  }

  // The server recorder bot offered a recv-only peer; answer it with our mic so
  // the conversation is captured server-side.
  private async onRecordOffer(env: Envelope) {
    if (!this.localStream) return; // no active mic -> nothing to record
    const callId = env.call_id || "";
    const p = env.payload as { sdp?: RTCSessionDescriptionInit };
    if (!p?.sdp) return;

    const pc = new RTCPeerConnection({ iceServers: await this.iceServers() });
    this.recordPc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        realtime.send({ type: "record-ice", call_id: callId, payload: e.candidate.toJSON() });
      }
    };
    this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream!));
    await pc.setRemoteDescription(p.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    realtime.send({ type: "record-answer", call_id: callId, payload: { sdp: answer } });
  }
}

export const callManager = new CallManager();
