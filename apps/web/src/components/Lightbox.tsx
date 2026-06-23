import { useCallback, useEffect } from "react";
import { formatClock } from "@/lib/format";
import type { DiarySlot } from "@/types";

interface Props {
  slots: DiarySlot[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

function activityColor(pct: number): string {
  if (pct >= 75) return "#22c55e";
  if (pct >= 40) return "#facc15";
  return "#f87171";
}

export default function Lightbox({ slots, index, onClose, onNavigate }: Props) {
  const slot = slots[index];
  const hasPrev = index > 0;
  const hasNext = index < slots.length - 1;

  const prev = useCallback(() => {
    if (hasPrev) onNavigate(index - 1);
  }, [hasPrev, index, onNavigate]);
  const next = useCallback(() => {
    if (hasNext) onNavigate(index + 1);
  }, [hasNext, index, onNavigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose, prev, next]);

  if (!slot) return null;
  const imgUrl = slot.screenshot_url ?? slot.thumbnail_url ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-5 py-3 text-white/90"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">
            {slot.window_title || "Untitled window"}
          </p>
          <p className="text-xs text-white/60">
            {formatClock(slot.started_at)} · {index + 1} of {slots.length}
          </p>
          {slot.notes && (
            <p className="text-xs text-white/80 mt-1 italic line-clamp-2" title={slot.notes}>
              {slot.notes}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span
            className="px-2 py-0.5 rounded-full text-xs font-medium text-white"
            style={{ backgroundColor: activityColor(slot.activity_percent) }}
          >
            {slot.activity_percent}% active
          </span>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white text-xl leading-none px-2"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Image area */}
      <div
        className="flex-1 flex items-center justify-center px-4 pb-6 min-h-0"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={prev}
          disabled={!hasPrev}
          className="absolute left-3 text-white/70 hover:text-white disabled:opacity-20 text-3xl px-3 py-6"
          title="Previous (←)"
        >
          ‹
        </button>
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={slot.window_title ?? "screenshot"}
            className="max-h-full max-w-full object-contain rounded-lg shadow-2xl"
          />
        ) : (
          <div className="text-white/50 text-sm">No screenshot available</div>
        )}
        <button
          onClick={next}
          disabled={!hasNext}
          className="absolute right-3 text-white/70 hover:text-white disabled:opacity-20 text-3xl px-3 py-6"
          title="Next (→)"
        >
          ›
        </button>
      </div>
    </div>
  );
}
