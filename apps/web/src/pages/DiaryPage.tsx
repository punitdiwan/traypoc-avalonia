import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import NavBar from "@/components/NavBar";
import DiaryTimeline from "@/components/DiaryTimeline";
import { diaryApi, projectsApi, usersApi } from "@/lib/api";
import type { HourBucket } from "@/types";

function shiftDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

// Filter each hour's slots by project, recomputing the bucket totals so the
// activity bars/stats reflect only the selected project. Empty hours drop out.
function filterByProject(hours: HourBucket[], projectId: string): HourBucket[] {
  if (projectId === "all") return hours;
  const match = (pid: string | null) =>
    projectId === "unassigned" ? pid === null : pid === projectId;

  return hours.flatMap((b) => {
    const slots = b.slots.filter((s) => match(s.project_id));
    if (slots.length === 0) return [];
    const total = slots.reduce((a, s) => a + s.duration_seconds, 0);
    const avg = Math.round(slots.reduce((a, s) => a + s.activity_percent, 0) / slots.length);
    return [{ ...b, slots, total_seconds: total, avg_activity: avg }];
  });
}

export default function DiaryPage() {
  const { userId } = useParams<{ userId: string }>();
  const [date, setDate] = useState(today);
  const [project, setProject] = useState("all");

  const { data: employees = [] } = useQuery({
    queryKey: ["employees"],
    queryFn: usersApi.list,
  });
  const employee = employees.find((e) => e.id === userId);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: projectsApi.list,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["diary", userId, date],
    queryFn: () => diaryApi.get(userId!, date),
    enabled: !!userId,
  });

  const hours = useMemo(
    () => (data ? filterByProject(data.hours, project) : []),
    [data, project]
  );

  const totalSeconds = hours.reduce((acc, h) => acc + h.total_seconds, 0);
  const avgActivity =
    hours.length > 0
      ? Math.round(hours.reduce((a, h) => a + h.avg_activity, 0) / hours.length)
      : 0;
  const intervals = hours.reduce((a, h) => a + h.slots.length, 0);

  const isToday = date === today();

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Work Diary</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {employee?.email ?? <span className="font-mono text-gray-400">{userId}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="unassigned">Unassigned</option>
            </select>
            <button
              onClick={() => setDate((d) => shiftDate(d, -1))}
              className="px-2.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              title="Previous day"
            >
              ‹
            </button>
            <input
              type="date"
              value={date}
              max={today()}
              onChange={(e) => setDate(e.target.value)}
              className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 [color-scheme:light] dark:[color-scheme:dark]"
            />
            <button
              onClick={() => setDate((d) => shiftDate(d, 1))}
              disabled={isToday}
              className="px-2.5 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
              title="Next day"
            >
              ›
            </button>
            <button
              onClick={() => setDate(today())}
              disabled={isToday}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
            >
              Today
            </button>
          </div>
        </div>

        {/* Summary bar */}
        {data && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            <Stat label="Hours tracked" value={`${(totalSeconds / 3600).toFixed(1)}h`} />
            <Stat label="Avg activity" value={`${avgActivity}%`} />
            <Stat label="Intervals" value={`${intervals}`} />
          </div>
        )}

        {/* Timeline */}
        {isLoading && <p className="text-gray-400 dark:text-gray-500 text-sm">Loading…</p>}
        {error && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load diary"}
          </p>
        )}
        {data && <DiaryTimeline hours={hours} />}
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
