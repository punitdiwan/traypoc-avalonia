import { formatClock, formatDuration } from "@/lib/format";
import type { DailyDiary, HourBucket, DiarySlot } from "@/types";

interface Props {
  days: DailyDiary[];
  projectNames: Record<string, string>;
  canDelete: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleDay: (date: string, ids: string[]) => void;
  canEdit?: boolean;
  onEdit?: (slot: DiarySlot) => void;
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function activityBadge(pct: number) {
  const cls =
    pct >= 75
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
      : pct >= 40
      ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
      : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {pct}%
    </span>
  );
}

export default function DiaryTable({
  days,
  projectNames,
  canDelete,
  selected,
  onToggle,
  onToggleDay,
  canEdit = false,
  onEdit,
}: Props) {
  if (days.length === 0) {
    return (
      <p className="text-gray-400 dark:text-gray-500 text-sm text-center py-12">
        No activity recorded for this period.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {days.map((day) => {
        const allSlots: DiarySlot[] = day.hours.flatMap((h: HourBucket) => h.slots);
        if (allSlots.length === 0) return null;
        const dayIds = allSlots.map((s) => s.id);
        const allChecked = dayIds.every((id) => selected.has(id));
        const someChecked = dayIds.some((id) => selected.has(id));

        return (
          <div key={day.date}>
            {/* Day header */}
            <div className="flex items-center gap-3 mb-3">
              {canDelete && (
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                  onChange={() => onToggleDay(day.date, dayIds)}
                  className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-600 focus:ring-brand-500 cursor-pointer"
                  title={allChecked ? "Deselect all for this day" : "Select all for this day"}
                />
              )}
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide flex-1 border-b border-gray-200 dark:border-gray-800 pb-2">
                {fmtDate(day.date)}
                <span className="ml-2 font-normal normal-case text-gray-400 dark:text-gray-500">
                  · {allSlots.length} interval{allSlots.length !== 1 ? "s" : ""}
                  {" · "}
                  {formatDuration(allSlots.reduce((a, s) => a + s.duration_seconds, 0))}
                </span>
              </h2>
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {canDelete && <th className="w-8 px-3 py-2" />}
                    <th className="px-4 py-2 text-left font-medium">Time</th>
                    <th className="px-4 py-2 text-left font-medium">Duration</th>
                    <th className="px-4 py-2 text-left font-medium">Activity</th>
                    <th className="px-4 py-2 text-left font-medium">Project</th>
                    <th className="px-4 py-2 text-left font-medium">App</th>
                    <th className="px-4 py-2 text-left font-medium">Window / Type</th>
                    <th className="px-4 py-2 text-left font-medium">Notes</th>
                    {canEdit && <th className="w-10 px-3 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {allSlots.map((slot) => {
                    const isChecked = selected.has(slot.id);
                    const projectName = slot.project_id ? (projectNames[slot.project_id] ?? "—") : "—";
                    const isManual = slot.window_title === "Manual entry";
                    return (
                      <tr
                        key={slot.id}
                        className={`transition-colors ${
                          isChecked
                            ? "bg-brand-50 dark:bg-brand-900/10"
                            : "hover:bg-gray-50 dark:hover:bg-gray-800/30"
                        }`}
                      >
                        {canDelete && (
                          <td className="px-3 py-2.5 text-center">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => onToggle(slot.id)}
                              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-600 focus:ring-brand-500 cursor-pointer"
                            />
                          </td>
                        )}
                        <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 whitespace-nowrap font-mono text-xs">
                          {formatClock(slot.started_at)}
                          <span className="text-gray-400 dark:text-gray-500 mx-1">→</span>
                          {formatClock(slot.ended_at)}
                        </td>
                        <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                          {formatDuration(slot.duration_seconds)}
                        </td>
                        <td className="px-4 py-2.5">
                          {isManual ? (
                            <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                          ) : (
                            activityBadge(slot.activity_percent)
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300 max-w-[150px] truncate">
                          {projectName}
                        </td>
                        <td className="px-4 py-2.5">
                          {slot.app_name ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 max-w-[120px] truncate" title={slot.app_name}>
                              {slot.app_name}
                            </span>
                          ) : (
                            <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 max-w-[200px] truncate">
                          {isManual ? (
                            <span className="inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded">
                              Manual
                            </span>
                          ) : (
                            <span title={slot.window_title ?? ""}>{slot.window_title || "—"}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 max-w-[250px]">
                          {slot.notes ? (
                            <span className="italic text-xs" title={slot.notes}>
                              {slot.notes.length > 60 ? slot.notes.slice(0, 60) + "…" : slot.notes}
                            </span>
                          ) : (
                            <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                          )}
                        </td>
                        {canEdit && (
                          <td className="px-3 py-2.5 text-center">
                            <button
                              onClick={() => onEdit?.(slot)}
                              title="Edit entry"
                              className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
                                <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.714 1.268L5.5 10.25a.75.75 0 0 0 .914.914l2.208-.536a2.75 2.75 0 0 0 1.268-.714l4.261-4.263a1.75 1.75 0 0 0 0-2.475l-.663-.663ZM3.75 12.5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Z" />
                              </svg>
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
