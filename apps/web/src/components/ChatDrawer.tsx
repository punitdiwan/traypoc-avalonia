// Slide-over chat panel shared by the employer (per employee) and the employee
// (with their admin). Realtime + history go through chatManager (LiveKit data
// messaging + REST). Full-screen on phones, a right-hand drawer on larger screens.
import { useEffect, useRef, useState } from "react";
import { chatManager } from "@/lib/chat";
import { useAuthStore } from "@/lib/auth";
import type { Message } from "@/types";

export default function ChatDrawer({
  peerId,
  name,
  onClose,
}: {
  peerId: string;
  name: string;
  onClose: () => void;
}) {
  const me = useAuthStore((s) => s.user?.id);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => setMessages(chatManager.messagesFor(peerId));
    const unsub = chatManager.subscribe(sync);
    void chatManager.openConversation(peerId).then(sync);
    sync();
    return () => {
      unsub();
      chatManager.closeConversation(peerId);
    };
  }, [peerId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    void chatManager.send(peerId, body);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative flex h-[100dvh] w-full max-w-full sm:max-w-md flex-col bg-white dark:bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-4 py-3 sm:px-5 sm:py-4">
          <h3 className="truncate font-semibold text-gray-900 dark:text-gray-100">{name}</h3>
          <button
            onClick={onClose}
            aria-label="Close chat"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto overscroll-contain p-4">
          {messages.length === 0 && (
            <p className="text-center text-sm text-gray-400">No messages yet.</p>
          )}
          {messages.map((m) => {
            const mine = m.sender_id === me;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
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

        <div className="flex items-center gap-2 border-t border-gray-200 dark:border-gray-800 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Type a message…"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2.5 text-base sm:text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          />
          <button
            onClick={send}
            className="shrink-0 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
