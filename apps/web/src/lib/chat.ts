// 1:1 chat manager, built on LiveKit data messaging (not the call signaling WS).
//
// Each employer<->employee conversation flows through a single persistent LiveKit
// room named after the *employee* ("dm-<employeeId>", minted server-side):
//   - the employee stays joined to their own inbox for the whole session, so any
//     admin message arrives in realtime and pops up anywhere in the app;
//   - an employer joins that employee's inbox only while a conversation is open.
//
// Durability is REST: send() persists via POST /messages (the authorization gate
// + canonical id/timestamp), then broadcasts that row over LiveKit data so the
// peer sees it instantly. History loads via GET /messages on open.

import { Room, RoomEvent, type RemoteParticipant } from "livekit-client";
import { messagesApi } from "./api";
import { useToastStore } from "./toast";
import type { Message } from "@/types";

type Listener = () => void;
const CHAT_TOPIC = "chat";

class ChatManager {
  private myId = "";
  private myRole = "";
  private room: Room | null = null;
  private roomName = ""; // LiveKit room we're currently connected to
  private connectPromise: Promise<void> | null = null;
  private messages = new Map<string, Message[]>(); // peerId -> thread
  private unread = new Map<string, number>(); // peerId -> unread count
  private activePeer: string | null = null; // open conversation (suppresses its popups)
  private listeners = new Set<Listener>();
  private inited = false;
  // Message ids we've already alerted on, so the LiveKit and Web Push paths don't
  // both toast the same message.
  private alerted = new Set<string>();

  /** Wire up for the signed-in user. Call once after login. */
  init(user: { id: string; role: string }) {
    if (this.inited && this.myId === user.id) return;
    this.inited = true;
    this.myId = user.id;
    this.myRole = user.role;
    // Best-effort desktop notification permission so popups can surface when the
    // tab is unfocused.
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    // Background alerts: the service worker forwards new-message pushes here so an
    // open-but-not-looking app (e.g. an employer with the drawer closed) still gets
    // a toast. Closed apps get a system notification straight from the SW.
    window.addEventListener("chat-notification", this.onPushAlert as EventListener);

    // Employees keep a live inbox connection for the whole session; employers
    // connect on demand when they open a conversation.
    if (this.myRole === "employee") void this.connectRoom(undefined).catch(() => {});
  }

  private onPushAlert = (e: Event) => {
    const d = (e as CustomEvent).detail as { from?: string; name?: string; id?: string; body?: string };
    if (!d?.from) return;
    this.alert(d.from, d.id, d.body || "New message", d.name);
  };

  /** Tear down on logout. */
  reset() {
    window.removeEventListener("chat-notification", this.onPushAlert as EventListener);
    this.room?.disconnect();
    this.room = null;
    this.roomName = "";
    this.connectPromise = null;
    this.messages.clear();
    this.unread.clear();
    this.alerted.clear();
    this.activePeer = null;
    this.inited = false;
    this.myId = "";
    this.myRole = "";
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  messagesFor(peerId: string): Message[] {
    return this.messages.get(peerId) ?? [];
  }
  unreadFor(peerId: string): number {
    return this.unread.get(peerId) ?? 0;
  }
  totalUnread(): number {
    let n = 0;
    this.unread.forEach((v) => (n += v));
    return n;
  }

  // The DM room is deterministic (employee's inbox), so we can skip a redundant
  // reconnect without a round-trip. Mirrors the server's "dm-<employeeId>".
  private desiredRoom(peerId?: string): string {
    return this.myRole === "employee" ? `dm-${this.myId}` : `dm-${peerId}`;
  }

  // Ensure the LiveKit room is connected. `peerId` is the employee id for an
  // employer; ignored for an employee (always their own inbox).
  private async connectRoom(peerId: string | undefined): Promise<void> {
    const want = this.desiredRoom(peerId);
    if (this.room && this.roomName === want) return;
    if (this.connectPromise) {
      await this.connectPromise.catch(() => {});
      if (this.room && this.roomName === want) return;
    }
    this.connectPromise = this.doConnect(peerId);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(peerId: string | undefined): Promise<void> {
    const { url, token, room } = await messagesApi.token(
      this.myRole === "employee" ? undefined : peerId,
    );
    if (this.room && this.roomName === room) return;
    // Employer switching conversations: drop the previous room first.
    if (this.room) {
      this.room.disconnect();
      this.room = null;
      this.roomName = "";
    }
    const lkRoom = new Room();
    lkRoom.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _p?: RemoteParticipant, _k?: unknown, topic?: string) => {
        if (topic && topic !== CHAT_TOPIC) return;
        this.onData(payload);
      },
    );
    lkRoom.on(RoomEvent.Disconnected, () => {
      if (this.room === lkRoom) {
        this.room = null;
        this.roomName = "";
      }
    });
    await lkRoom.connect(url, token);
    this.room = lkRoom;
    this.roomName = room;
  }

  private onData(payload: Uint8Array) {
    let msg: Message;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (!msg?.body || !msg.sender_id) return;
    // Inbound data is always from the other party (LiveKit doesn't echo our own
    // publishes back to us), so the peer is whoever isn't me.
    const peer = msg.sender_id === this.myId ? msg.recipient_id : msg.sender_id;
    this.append(peer, msg);
    if (msg.recipient_id === this.myId) {
      this.alert(peer, msg.id, msg.body);
    }
    this.emit();
  }

  private append(peer: string, msg: Message) {
    const list = this.messages.get(peer) ?? [];
    if (list.some((m) => m.id === msg.id)) return; // dedupe optimistic echo
    this.messages.set(peer, [...list, msg]);
  }

  // Raise an in-app alert (toast + unread bump) for an inbound message, unless the
  // conversation is already open or we've alerted on this id via the other path.
  private alert(peer: string, msgId: string | undefined, preview: string, name?: string) {
    if (msgId) {
      if (this.alerted.has(msgId)) return;
      this.alerted.add(msgId);
      if (this.alerted.size > 500) this.alerted.clear();
    }
    if (this.activePeer === peer) return; // they're looking at it
    this.unread.set(peer, (this.unread.get(peer) ?? 0) + 1);
    const text = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;
    useToastStore.getState().addToast(name ? `💬 ${name}: ${text}` : `💬 New message: ${text}`, "info");
    this.emit();
  }

  /** Open a conversation: connect, load history, clear its unread badge. */
  async openConversation(peerId: string) {
    this.activePeer = peerId;
    this.unread.set(peerId, 0);
    this.emit();
    try {
      await this.connectRoom(peerId);
    } catch {
      /* realtime unavailable — history still loads and sends still persist */
    }
    try {
      const history = await messagesApi.list(peerId);
      this.messages.set(peerId, history);
      this.emit();
    } catch {
      /* ignore */
    }
  }

  closeConversation(peerId: string) {
    if (this.activePeer === peerId) this.activePeer = null;
    // Employers don't keep a persistent inbox — release the room when done.
    if (this.myRole !== "employee" && this.room) {
      this.room.disconnect();
      this.room = null;
      this.roomName = "";
    }
    this.emit();
  }

  async send(peerId: string, body: string) {
    const text = body.trim();
    if (!text) return;
    let stored: Message;
    try {
      stored = await messagesApi.send(peerId, text);
    } catch {
      useToastStore.getState().addToast("Failed to send message", "error");
      return;
    }
    this.append(peerId, stored);
    this.emit();
    // Broadcast over LiveKit so the peer sees it without reloading history.
    try {
      if (!this.room) await this.connectRoom(peerId);
      const data = new TextEncoder().encode(JSON.stringify(stored));
      await this.room?.localParticipant.publishData(data, { reliable: true, topic: CHAT_TOPIC });
    } catch {
      /* peer will pick it up from history on next open */
    }
  }
}

export const chatManager = new ChatManager();
