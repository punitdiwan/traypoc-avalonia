// Per-employee communication controls for the employer: a Call button (starts a
// WebRTC voice call) and a Message button (opens a chat drawer). Drop one into
// each employee row.
import { useEffect, useRef, useState } from "react";
import { callManager } from "@/lib/call";
import { realtime } from "@/lib/realtime";
import { messagesApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import type { Message } from "@/types";

export default function EmployeeComms({ userId, name }: { userId: string; name: string }) {
  const [chatOpen, setChatOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => callManager.startCall(userId, name)}
        title={`Call ${name}`}
        className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        📞 Call
      </button>
      <button
        onClick={() => setChatOpen(true)}
        title={`Message ${name}`}
        className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        💬 Message
      </button>
      {chatOpen && <ChatDrawer userId={userId} name={name} onClose={() => setChatOpen(false)} />}
    </div>
  );
}

function ChatDrawer({
  userId,
  name,
  onClose,
}: {
  userId: string;
  name: string;
  onClose: () => void;
}) {
  const me = useAuthStore((s) => s.user?.id);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesApi.list(userId).then(setMessages).catch(() => {});
  }, [userId]);

  // Append inbound chat from this peer (and echoes of our own sends).
  useEffect(() => {
    return realtime.on((env) => {
      if (env.type !== "chat-message") return;
      const relevant = env.from === userId || env.to === userId;
      if (!relevant) return;
      const p = env.payload as { id?: string; body?: string; created_at?: string };
      if (!p?.body) return;
      setMessages((prev) => [
        ...prev,
        {
          id: p.id || crypto.randomUUID(),
          org_id: "",
          sender_id: env.from || "",
          recipient_id: env.to || "",
          body: p.body!,
          created_at: p.created_at || new Date().toISOString(),
          read_at: null,
        },
      ]);
    });
  }, [userId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    // Optimistic append; the server echo carries the canonical id/timestamp.
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        org_id: "",
        sender_id: me || "",
        recipient_id: userId,
        body,
        created_at: new Date().toISOString(),
        read_at: null,
      },
    ]);
    realtime.send({ type: "chat-message", to: userId, payload: { body } });
    setDraft("");
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative flex h-full w-full max-w-md flex-col bg-white dark:bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-5 py-4">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">{name}</h3>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {messages.length === 0 && (
            <p className="text-center text-sm text-gray-400">No messages yet.</p>
          )}
          {messages.map((m) => {
            const mine = m.sender_id === me;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                    mine
                      ? "bg-brand-600 text-white"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  }`}
                >
                  {m.body}
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        <div className="flex items-center gap-2 border-t border-gray-200 dark:border-gray-800 p-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Type a message…"
            className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
          <button
            onClick={send}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
