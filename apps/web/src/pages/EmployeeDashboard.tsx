import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import NavBar from "@/components/NavBar";
import { StatSkeleton, Skeleton } from "@/components/Skeleton";
import { diaryApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import { displayName } from "@/lib/format";
import type { DiarySlot } from "@/types";

const today = () => new Date().toISOString().slice(0, 10);

// Manual entries carry no screenshot — show the same shared placeholder the diary uses.
const MANUAL_PLACEHOLDER = "/manual-screenshot.svg";
function thumbFor(s: DiarySlot): string {
  if (s.thumbnail_url || s.screenshot_url) return (s.thumbnail_url ?? s.screenshot_url)!;
  if (s.window_title === "Manual entry") return MANUAL_PLACEHOLDER;
  return "";
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Read-only "today" summary for the signed-in employee, plus a jump to their diary. */
export default function EmployeeDashboard() {
  const user = useAuthStore((s) => s.user);
  const date = today();

  const { data, isLoading } = useQuery({
    queryKey: ["diary", user?.id, date, date],
    queryFn: () => diaryApi.get(user!.id, date, date),
    enabled: !!user,
  });

  const { totalSeconds, avgActivity, intervals, recent } = useMemo(() => {
    const hours = data?.days[0]?.hours ?? [];
    const slots = hours.flatMap((h) => h.slots);
    const total = hours.reduce((a, h) => a + h.total_seconds, 0);
    const avg =
      hours.length > 0
        ? Math.round(hours.reduce((a, h) => a + h.avg_activity, 0) / hours.length)
        : 0;
    // Most-recent screenshots first, capped for a compact strip.
    const recent = [...slots].reverse().slice(0, 12);
    return { totalSeconds: total, avgActivity: avg, intervals: slots.length, recent };
  }, [data]);

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">My Dashboard</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {user ? displayName(user) : ""} · Today
            </p>
          </div>
          {user && (
            <Link
              to={`/diary/${user.id}`}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Open Work Diary →
            </Link>
          )}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-3 gap-4 mb-8">
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4 mb-8">
            <Stat label="Hours tracked today" value={`${(totalSeconds / 3600).toFixed(1)}h`} />
            <Stat label="Avg activity" value={`${avgActivity}%`} />
            <Stat label="Intervals" value={`${intervals}`} />
          </div>
        )}

        <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Recent screenshots</h2>
        {isLoading ? (
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-14 w-24" />
            <Skeleton className="h-14 w-24" />
            <Skeleton className="h-14 w-24" />
          </div>
        ) : recent.length === 0 ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm py-8 text-center">
            No activity recorded yet today.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {recent.map((s) => {
              const url = thumbFor(s);
              return (
                <div key={s.id} className="relative" title={`${fmtTime(s.started_at)} · ${s.window_title ?? ""}`}>
                  {url ? (
                    <img
                      src={url}
                      alt={s.window_title ?? "screenshot"}
                      className="w-24 h-14 object-cover rounded border border-gray-200 dark:border-gray-700"
                    />
                  ) : (
                    <div className="w-24 h-14 rounded border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-gray-300 dark:text-gray-600 text-xs">
                      no img
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-5 py-4">
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}
