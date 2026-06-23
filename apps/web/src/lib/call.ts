// 1:1 audio call manager, on top of LiveKit (SFU) for media + our signaling
// WebSocket for ringing.
//
// LiveKit has no notion of "ringing", so the WS hub still carries the call
// lifecycle: a call-offer rings the callee (and fires a push), call-accept /
// call-reject / call-cancel / hangup drive state and the persisted call row. The
// actual audio never touches our API — both peers join a LiveKit *room* named
// after the call id and the SFU relays between them.
//
// Caller:  startCall() -> ring (call-offer) + join room, publish mic -> wait
//          for the callee's participant to appear -> connected.
// Callee:  receive call-offer (state "incoming") -> accept() -> join room,
//          publish mic + send call-accept -> connected.
//
// Recording is server-side (LiveKit Egress), toggled by the employer via the
// existing record-control message — no client media peer involved.

import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { callsApi } from "./api";
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
  // Remote audio output (speaker) on/off — UI mutes/routes the <audio> element.
  speakerOn = true;
  // Whether THIS client may control server-side recording (employer/god only),
  // set by the UI after login, and the admin's current record preference.
  canRecord = false;
  recordEnabled = true;

  // LiveKit room for the active call. The remote audio element is created and
  // owned here (via track.attach) so playback goes through LiveKit's pipeline —
  // hand-rolling a MediaStream + <audio srcObject> caused glitchy/echoey audio,
  // especially on iOS.
  private room: Room | null = null;
  private audioEl: HTMLAudioElement | null = null;
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

  // Join the LiveKit room for a call and publish the mic. Remote audio arrives
  // via TrackSubscribed; the peer's presence flips us to "connected".
  private async joinRoom(callId: string) {
    const { url, token } = await callsApi.livekitToken(callId);
    // echoCancellation/noiseSuppression/autoGainControl on the mic keep the call
    // clean (no echo/howl); without them you get garbled, noisy audio.
    const room = new Room({
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        // Let LiveKit create & drive the audio element (correct jitter buffer +
        // iOS handling), then we just position/route it.
        const el = track.attach();
        el.autoplay = true;
        el.setAttribute("playsinline", "true");
        this.audioEl = el;
        document.body.appendChild(el);
        void this.applySpeaker();
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
      this.audioEl = null;
    });
    room.on(RoomEvent.ParticipantConnected, () => this.onPeerPresent());
    room.on(RoomEvent.ParticipantDisconnected, () => {
      if (room.remoteParticipants.size === 0 && this.state !== "ended") this.cleanup("ended");
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.state !== "ended") this.cleanup("ended");
    });

    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    // iOS blocks autoplay until a gesture; accept()/startCall() are click-driven,
    // so unlock playback here.
    try {
      await room.startAudio();
    } catch {
      /* not needed / already unlocked */
    }
    this.room = room;
    // The other side may already be in the room (they joined first).
    if (room.remoteParticipants.size > 0) this.onPeerPresent();
  }

  // Route remote audio to loudspeaker vs earpiece via setSinkId (where supported;
  // absent on iOS Safari, which just uses the default route). We never mute the
  // element — that would kill the voice.
  private async applySpeaker() {
    const el = this.audioEl as
      | (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
      | null;
    if (!el) return;
    el.muted = false;
    if (typeof el.setSinkId !== "function") return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === "audiooutput");
      if (!outputs.length) return;
      const label = (d: MediaDeviceInfo) => d.label.toLowerCase();
      const target = this.speakerOn
        ? outputs.find((d) => /speaker|speakerphone/.test(label(d))) ??
          outputs.find((d) => d.deviceId === "default") ??
          outputs[0]
        : outputs.find((d) => /earpiece|earphone|receiver/.test(label(d))) ??
          outputs.find((d) => d.deviceId === "communications") ??
          outputs[0];
      if (target) await el.setSinkId(target.deviceId);
    } catch {
      /* no permission / unsupported sink — leave on default route */
    }
  }

  // Both peers are now in the room — the call is live.
  private onPeerPresent() {
    if (this.state === "connected") return;
    this.state = "connected";
    if (!this.startedAt) {
      this.startedAt = Date.now();
      // Tell the server whether to record this call (employer/god only).
      if (this.canRecord) this.sendRecordControl();
    }
    this.emit();
  }

  /** Outgoing call to a peer user. */
  async startCall(peerId: string, peerName: string) {
    if (this.state !== "idle" && this.state !== "ended") return;
    const callId = crypto.randomUUID();
    this.info = { callId, peerId, peerName, outgoing: true };
    this.state = "calling";
    this.startedAt = 0;
    this.emit();

    // Ring the callee (also persists the call row + fires a push).
    realtime.send({ type: "call-offer", to: peerId, call_id: callId });
    try {
      await this.joinRoom(callId);
    } catch {
      this.hangup();
    }
  }

  /** Accept an incoming call. */
  async accept() {
    if (this.state !== "incoming" || !this.info) return;
    this.state = "connecting";
    this.emit();
    realtime.send({ type: "call-accept", to: this.info.peerId, call_id: this.info.callId });
    try {
      await this.joinRoom(this.info.callId);
    } catch {
      this.hangup();
    }
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
    void this.room?.localParticipant.setMicrophoneEnabled(!this.muted);
    this.emit();
  }

  /** Toggle remote audio output between loudspeaker and earpiece. */
  toggleSpeaker() {
    this.speakerOn = !this.speakerOn;
    void this.applySpeaker();
    this.emit();
  }

  /** Admin-only: enable/disable server-side recording for the active call. */
  setRecordEnabled(enabled: boolean) {
    this.recordEnabled = enabled;
    this.emit();
    if (this.canRecord && (this.state === "connected" || this.state === "connecting")) {
      this.sendRecordControl();
    }
  }

  toggleRecord() {
    this.setRecordEnabled(!this.recordEnabled);
  }

  private sendRecordControl() {
    if (!this.info) return;
    realtime.send({
      type: "record-control",
      call_id: this.info.callId,
      payload: { enabled: this.recordEnabled },
    });
  }

  private cleanup(state: CallState) {
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
    this.room?.disconnect();
    this.room = null;
    this.muted = false;
    this.speakerOn = true;
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

  private onSignal(env: Envelope) {
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
        this.state = "incoming";
        this.emit();
        break;
      }
      case "call-accept": {
        // The callee accepted; surface "connecting" until their media arrives.
        if (this.state === "calling") {
          this.state = "connecting";
          this.emit();
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
    }
  }
}

export const callManager = new CallManager();
