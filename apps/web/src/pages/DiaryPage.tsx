import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import NavBar from "@/components/NavBar";
import DiaryTimeline from "@/components/DiaryTimeline";
import DiaryTable from "@/components/DiaryTable";
import EditTimeLogModal from "@/components/EditTimeLogModal";
import { Skeleton, StatSkeleton } from "@/components/Skeleton";
import { diaryApi, projectsApi, timeLogsApi, usersApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import { useToastStore } from "@/lib/toast";
import { displayName, todayISO } from "@/lib/format";
import type { HourBucket, DailyDiary, DiarySlot } from "@/types";

const today = () => todayISO();

const MANUAL_PLACEHOLDER = "/manual-screenshot.svg";

function withManualPlaceholders(hours: HourBucket[]): HourBucket[] {
  return hours.map((b) => ({
    ...b,
    slots: b.slots.map((s) =>
      !s.screenshot_url && !s.thumbnail_url && s.window_title === "Manual entry"
        ? { ...s, screenshot_url: MANUAL_PLACEHOLDER, thumbnail_url: MANUAL_PLACEHOLDER }
        : s
    ),
  }));
}

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

function processDay(day: DailyDiary, projectId: string): HourBucket[] {
  return withManualPlaceholders(filterByProject(day.hours, projectId));
}

function fmtDateLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

type ViewMode = "screenshot" | "table";

export default function DiaryPage() {
  const { userId } = useParams<{ userId: string }>();
  const todayStr = today();
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [project, setProject] = useState("all");
  const [view, setView] = useState<ViewMode>("screenshot");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<DiarySlot | null>(null);

  const currentUser = useAuthStore((s) => s.user);
  const isEmployee = currentUser?.role === "employee";
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();

  const { data: employees = [] } = useQuery({
    queryKey: ["employees"],
    queryFn: usersApi.list,
    enabled: !isEmployee,
  });
  const employee = isEmployee ? currentUser : employees.find((e) => e.id === userId);

  // Owners can always delete; employees only when allow_delete is granted.
  const canDelete = currentUser
    ? currentUser.role !== "employee" || !!currentUser.allow_delete
    : false;

  const del = useMutation({
    mutationFn: (id: string) => timeLogsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["diary", userId, from, to] });
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Delete failed", "error"),
  });

  const bulkDelete = useCallback(async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const n = ids.length;
    if (!window.confirm(`Delete ${n} selected interval${n !== 1 ? "s" : ""} and their tracked time? This can't be undone.`)) return;
    try {
      await Promise.all(ids.map((id) => timeLogsApi.delete(id)));
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["diary", userId, from, to] });
      addToast(`Deleted ${n} interval${n !== 1 ? "s" : ""}`);
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  }, [selected, userId, from, to, qc, addToast]);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: projectsApi.list,
  });

  // Build a lookup map for project names used by the table view.
  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.name])),
    [projects]
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ["diary", userId, from, to],
    queryFn: () => diaryApi.get(userId!, from, to),
    enabled: !!userId,
  });

  // When data changes, clear selection (avoids stale ids after a date change).
  const prevDataRef = useMemo(() => ({ data }), [data]);
  if (prevDataRef.data !== data) setSelected(new Set());

  // Per-day filtered hours for rendering.
  const filteredDays = useMemo(
    () => (data?.days ?? []).map((day) => ({ date: day.date, hours: processDay(day, project) })),
    [data, project]
  );

  const allHours = useMemo(() => filteredDays.flatMap((d) => d.hours), [filteredDays]);
  const totalSeconds = allHours.reduce((acc, h) => acc + h.total_seconds, 0);
  const avgActivity =
    allHours.length > 0
      ? Math.round(allHours.reduce((a, h) => a + h.avg_activity, 0) / allHours.length)
      : 0;
  const intervals = allHours.reduce((a, h) => a + h.slots.length, 0);
  const isToday = from === todayStr && to === todayStr;
  const isRange = from !== to;

  function handleFromChange(val: string) {
    setFrom(val);
    if (val > to) setTo(val);
    setSelected(new Set());
  }
  function handleToChange(val: string) {
    setTo(val);
    if (val < from) setFrom(val);
    setSelected(new Set());
  }

  // Table selection helpers.
  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleDay = useCallback((_date: string, ids: string[]) => {
    setSelected((prev) => {
      const allOn = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const ViewToggle = (
    <div className="flex items-center rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden text-sm">
      {(["screenshot", "table"] as ViewMode[]).map((v) => (
        <button
          key={v}
          onClick={() => { setView(v); setSelected(new Set()); }}
          className={`px-3 py-2 transition-colors ${
            view === v
              ? "bg-brand-600 text-white"
              : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          }`}
        >
          {v === "screenshot" ? "📷 Screenshots" : "📋 Table"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Work Diary</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {employee ? displayName(employee) : <span className="font-mono text-gray-400">{userId}</span>}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Project filter */}
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <option value="unassigned">Unassigned</option>
            </select>

            {/* Date range */}
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-gray-500 dark:text-gray-400">From</label>
              <input
                type="date"
                value={from}
                max={todayStr}
                onChange={(e) => handleFromChange(e.target.value)}
                className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 [color-scheme:light] dark:[color-scheme:dark]"
              />
              <label className="text-xs text-gray-500 dark:text-gray-400">To</label>
              <input
                type="date"
                value={to}
                min={from}
                max={todayStr}
                onChange={(e) => handleToChange(e.target.value)}
                className="border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 [color-scheme:light] dark:[color-scheme:dark]"
              />
            </div>

            <button
              onClick={() => { setFrom(todayStr); setTo(todayStr); }}
              disabled={isToday}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
            >
              Today
            </button>

            {ViewToggle}
          </div>
        </div>

        {/* Bulk delete bar — table view only, when items are selected */}
        {view === "table" && canDelete && selected.size > 0 && (
          <div className="flex items-center gap-3 mb-4 px-4 py-2.5 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-xl">
            <span className="text-sm text-red-700 dark:text-red-400 font-medium flex-1">
              {selected.size} interval{selected.size !== 1 ? "s" : ""} selected
            </span>
            <button
              onClick={bulkDelete}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
            >
              Delete selected
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 transition-colors"
            >
              Clear
            </button>
          </div>
        )}

        {/* Summary bar */}
        {data && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            <Stat label={isRange ? "Total hours" : "Hours tracked"} value={`${(totalSeconds / 3600).toFixed(1)}h`} />
            <Stat label="Avg activity" value={`${avgActivity}%`} />
            <Stat label="Intervals" value={`${intervals}`} />
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              <StatSkeleton /><StatSkeleton /><StatSkeleton />
            </div>
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load diary"}
          </p>
        )}

        {/* Screenshot view */}
        {data && view === "screenshot" && (
          isRange ? (
            filteredDays.length === 0 ? (
              <p className="text-gray-400 dark:text-gray-500 text-sm text-center py-12">
                No activity recorded for this period.
              </p>
            ) : (
              <div className="space-y-10">
                {filteredDays.map((day) => (
                  <div key={day.date}>
                    <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-4 border-b border-gray-200 dark:border-gray-800 pb-2">
                      {fmtDateLabel(day.date)}
                    </h2>
                    <DiaryTimeline
                      hours={day.hours}
                      canDelete={canDelete}
                      onDelete={(id) => del.mutate(id)}
                    />
                  </div>
                ))}
              </div>
            )
          ) : (
            <DiaryTimeline
              hours={filteredDays[0]?.hours ?? []}
              canDelete={canDelete}
              onDelete={(id) => del.mutate(id)}
            />
          )
        )}

        {/* Table view */}
        {data && view === "table" && (
          <DiaryTable
            days={filteredDays}
            projectNames={projectNames}
            canDelete={canDelete}
            selected={selected}
            onToggle={toggleOne}
            onToggleDay={toggleDay}
            canEdit={canDelete}
            onEdit={setEditing}
          />
        )}
      </main>

      {editing && (
        <EditTimeLogModal
          slot={editing}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["diary", userId, from, to] })}
        />
      )}
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
