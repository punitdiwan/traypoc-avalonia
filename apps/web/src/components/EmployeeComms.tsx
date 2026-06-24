// Per-employee communication controls for the employer: a Call button (starts a
// WebRTC voice call) and a Message button (opens the chat drawer). Drop one into
// each employee row.
import { useState } from "react";
import { callManager } from "@/lib/call";
import ChatDrawer from "./ChatDrawer";

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
      {chatOpen && <ChatDrawer peerId={userId} name={name} onClose={() => setChatOpen(false)} />}
    </div>
  );
}
