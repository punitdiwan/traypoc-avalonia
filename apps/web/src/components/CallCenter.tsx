// Global call overlay: mounted once for every authenticated user. It initializes
// the signaling connection, plays the remote audio, and renders the incoming /
// outgoing / in-call UI. Employers start calls from the employee list; employees
// only ever see the incoming/in-call states here.
import { useEffect, useRef, useState } from "react";
import { callManager } from "@/lib/call";
import { useCall } from "@/lib/useCall";
import { setupPush } from "@/lib/push";
import { useAuthStore } from "@/lib/auth";

function useElapsed(active: boolean, startedAt: number): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active || !startedAt) return "";
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function CallCenter() {
  const call = useCall();
  const isAuthed = useAuthStore((s) => s.isAuthenticated());
  const audioRef = useRef<HTMLAudioElement>(null);

  // Start signaling + register push once authenticated.
  useEffect(() => {
    if (isAuthed) {
      callManager.init();
      setupPush();
    }
  }, [isAuthed]);

  // Pipe the remote stream into the audio element whenever it changes.
  useEffect(() => {
    if (audioRef.current && call.remoteStream) {
      audioRef.current.srcObject = call.remoteStream;
      audioRef.current.play().catch(() => {});
    }
  });

  const elapsed = useElapsed(call.state === "connected", call.startedAt);

  if (!isAuthed || call.state === "idle") {
    return <audio ref={audioRef} autoPlay />;
  }

  const peerName = call.info?.peerName || "Unknown";

  return (
    <>
      <audio ref={audioRef} autoPlay />
      <div className="fixed inset-x-0 bottom-0 z-[60] flex justify-center p-4 sm:bottom-6 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-400 text-lg font-semibold">
              {peerName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-gray-900 dark:text-gray-100">{peerName}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {call.state === "calling" && "Calling…"}
                {call.state === "incoming" && "Incoming call"}
                {call.state === "connecting" && "Connecting…"}
                {call.state === "connected" && `In call · ${elapsed}`}
                {call.state === "ended" && "Call ended"}
              </p>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-center gap-3">
            {call.state === "incoming" && (
              <>
                <button
                  onClick={() => callManager.reject()}
                  className="flex-1 rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2.5 text-sm font-medium text-white"
                >
                  Decline
                </button>
                <button
                  onClick={() => callManager.accept()}
                  className="flex-1 rounded-lg bg-green-600 hover:bg-green-700 px-4 py-2.5 text-sm font-medium text-white"
                >
                  Accept
                </button>
              </>
            )}

            {(call.state === "connected" || call.state === "connecting") && (
              <>
                <button
                  onClick={() => callManager.toggleMute()}
                  className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {call.muted ? "Unmute" : "Mute"}
                </button>
                <button
                  onClick={() => callManager.hangup()}
                  className="flex-1 rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2.5 text-sm font-medium text-white"
                >
                  Hang up
                </button>
              </>
            )}

            {call.state === "calling" && (
              <button
                onClick={() => callManager.hangup()}
                className="w-full rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2.5 text-sm font-medium text-white"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
