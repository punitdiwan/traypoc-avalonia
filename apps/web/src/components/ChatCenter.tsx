// Global chat mount, rendered once for every authenticated user.
//
//   - Initializes chatManager for everyone (employers need it for the per-employee
//     Message buttons on /manage; employees additionally open a live inbox so admin
//     messages pop up anywhere in the app).
//   - For employees it renders a floating "Message Admin" button with an unread
//     badge that opens the chat drawer addressed to the org's admin.
import { useEffect, useState } from "react";
import { chatManager } from "@/lib/chat";
import { messagesApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import ChatDrawer from "./ChatDrawer";

export default function ChatCenter() {
  const isAuthed = useAuthStore((s) => s.isAuthenticated());
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [admin, setAdmin] = useState<{ id: string; full_name: string; email: string } | null>(null);
  const [, force] = useState(0);

  // Init for every authenticated user (employers included).
  useEffect(() => {
    if (isAuthed && user) chatManager.init(user);
  }, [isAuthed, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render on unread/message changes so the badge stays live.
  useEffect(() => chatManager.subscribe(() => force((x) => x + 1)), []);

  // Employees resolve their admin (chat recipient).
  useEffect(() => {
    if (isAuthed && user?.role === "employee") {
      messagesApi.admin().then(setAdmin).catch(() => {});
    }
  }, [isAuthed, user?.role]);

  if (!isAuthed || user?.role !== "employee") return null;

  const unread = chatManager.totalUnread();
  const name = admin ? admin.full_name || admin.email : "Admin";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Message Admin"
        aria-label="Message Admin"
        className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-2xl text-white shadow-lg hover:bg-brand-700"
      >
        💬
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && admin && (
        <ChatDrawer peerId={admin.id} name={name} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
