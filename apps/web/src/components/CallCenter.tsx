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
  const user = useAuthStore((s) => s.user);
  const canRecord = !!user && user.role !== "employee";
  const audioRef = useRef<HTMLAudioElement>(null);

  // Start signaling + register push once authenticated.
  useEffect(() => {
    if (isAuthed) {
      callManager.canRecord = canRecord;
      callManager.init();
      setupPush();
    }
  }, [isAuthed, canRecord]);

  // Pipe the remote stream into the audio element whenever it changes.
  useEffect(() => {
    if (audioRef.current && call.remoteStream) {
      audioRef.current.srcObject = call.remoteStream;
      audioRef.current.play().catch(() => {});
    }
  });

  // Speaker on/off — route the remote audio to loudspeaker vs earpiece. We must
  // NOT mute (that kills the voice); instead we pick the output device. Only
  // platforms that expose setSinkId (e.g. Android Chrome, desktop) can switch —
  // elsewhere the audio simply keeps playing on the default route.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = false;
    void applyAudioOutput(el, call.speakerOn);
  }, [call.speakerOn, call.remoteStream]);

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

          <div className="mt-5">
            {call.state === "incoming" && (
              <div className="flex items-center justify-center gap-3">
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
              </div>
            )}

            {(call.state === "connected" || call.state === "connecting") && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <ToggleButton
                    active={!call.muted}
                    onClick={() => callManager.toggleMute()}
                    label={call.muted ? "🔇 Unmute" : "🎙 Mute"}
                  />
                  <ToggleButton
                    active={call.speakerOn}
                    onClick={() => callManager.toggleSpeaker()}
                    label={call.speakerOn ? "🔊 Speaker" : "🔈 Speaker off"}
                  />
                  {canRecord && (
                    <ToggleButton
                      active={call.recordEnabled}
                      onClick={() => callManager.toggleRecord()}
                      label={call.recordEnabled ? "⏺ Recording" : "⏺ Record"}
                      tone="rec"
                    />
                  )}
                </div>
                <button
                  onClick={() => callManager.hangup()}
                  className="w-full rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2.5 text-sm font-medium text-white"
                >
                  Hang up
                </button>
              </div>
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

// setSinkId is the only standard web hook for choosing an audio output device.
// It's absent on iOS Safari (audio stays on the default route there). When
// present, we try to pick the loudspeaker (speaker on) or the earpiece/receiver
// (speaker off). Device labels require a prior getUserMedia grant, which an
// active call already has.
type SinkCapableAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

async function applyAudioOutput(el: HTMLAudioElement, speakerOn: boolean) {
  const audio = el as SinkCapableAudio;
  if (typeof audio.setSinkId !== "function") return; // unsupported -> default route
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    if (outputs.length === 0) return;
    const label = (d: MediaDeviceInfo) => d.label.toLowerCase();
    const target = speakerOn
      ? outputs.find((d) => /speaker|speakerphone/.test(label(d))) ??
        outputs.find((d) => d.deviceId === "default") ??
        outputs[0]
      : outputs.find((d) => /earpiece|earphone|receiver/.test(label(d))) ??
        outputs.find((d) => d.deviceId === "communications") ??
        outputs[0];
    if (target) await audio.setSinkId(target.deviceId);
  } catch {
    // No permission / unsupported sink — leave the audio on its default route.
  }
}

function ToggleButton({
  active,
  onClick,
  label,
  tone = "default",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: "default" | "rec";
}) {
  const activeCls =
    tone === "rec"
      ? "bg-red-100 text-red-700 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800"
      : "bg-brand-100 text-brand-700 border-brand-300 dark:bg-brand-900/30 dark:text-brand-400 dark:border-brand-800";
  const idleCls =
    "bg-white text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700";
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-2 text-xs font-medium transition-colors ${active ? activeCls : idleCls}`}
    >
      {label}
    </button>
  );
}
