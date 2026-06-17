import { useMemo, useState } from "react";
import type { DiarySlot, HourBucket } from "@/types";
import Lightbox from "@/components/Lightbox";

interface Props {
  hours: HourBucket[];
}

function activityColor(pct: number): string {
  if (pct >= 75) return "bg-green-500";
  if (pct >= 40) return "bg-yellow-400";
  return "bg-red-400";
}

function fmt(hour: number): string {
  const h = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h}:00 ${ampm}`;
}

export default function DiaryTimeline({ hours }: Props) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Flatten every slot in chronological order so the lightbox can page
  // through the whole day, and remember each slot's flat index.
  const flatSlots = useMemo<DiarySlot[]>(
    () => hours.flatMap((b) => b.slots),
    [hours]
  );

  if (hours.length === 0) {
    return (
      <p className="text-gray-400 dark:text-gray-500 text-sm text-center py-12">
        No activity recorded for this day.
      </p>
    );
  }

  let runningIndex = 0;

  return (
    <div className="space-y-4">
      {hours.map((bucket) => (
        <div key={bucket.hour} className="flex gap-4 items-start">
          {/* Hour label */}
          <div className="w-16 text-right text-xs text-gray-400 dark:text-gray-500 pt-1 shrink-0">
            {fmt(bucket.hour)}
          </div>

          {/* Activity bar */}
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${activityColor(bucket.avg_activity)}`}
                  style={{ width: `${bucket.avg_activity}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 dark:text-gray-400 w-10 text-right">
                {bucket.avg_activity}%
              </span>
              <span className="text-xs text-gray-400 dark:text-gray-500 w-14 text-right">
                {Math.round(bucket.total_seconds / 60)}m
              </span>
            </div>

            {/* Screenshot thumbnails */}
            <div className="flex flex-wrap gap-2">
              {bucket.slots.map((slot) => {
                const flatIndex = runningIndex++;
                return (
                  <div key={flatIndex} className="relative group">
                    {slot.thumbnail_url || slot.screenshot_url ? (
                      <button
                        type="button"
                        onClick={() => setLightboxIndex(flatIndex)}
                        className="block"
                      >
                        <img
                          src={slot.thumbnail_url ?? slot.screenshot_url ?? ""}
                          alt={slot.window_title ?? "screenshot"}
                          className="w-24 h-14 object-cover rounded border border-gray-200 dark:border-gray-700 hover:border-brand-500 dark:hover:border-brand-400 transition-colors cursor-pointer"
                        />
                      </button>
                    ) : (
                      <div className="w-24 h-14 rounded border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-gray-300 dark:text-gray-600 text-xs">
                        no img
                      </div>
                    )}
                    {/* Tooltip with window title */}
                    {slot.window_title && (
                      <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10">
                        <div className="bg-gray-800 dark:bg-gray-700 text-white text-xs rounded px-2 py-1 whitespace-nowrap max-w-48 truncate">
                          {slot.window_title}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ))}

      {lightboxIndex !== null && (
        <Lightbox
          slots={flatSlots}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}
    </div>
  );
}
