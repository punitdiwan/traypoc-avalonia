import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import NavBar from "@/components/NavBar";
import { overviewApi } from "@/lib/api";
import { useThemeStore } from "@/lib/theme";
import { formatHours, formatMoney } from "@/lib/format";
import type { DailyPoint, EmployeeSummary, ProjectSummary } from "@/types";

const RANGES = [
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
];

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function activityColor(pct: number): string {
  if (pct >= 75) return "#22c55e";
  if (pct >= 40) return "#facc15";
  return "#f87171";
}

export default function OverviewPage() {
  const [days, setDays] = useState(7);
  const dark = useThemeStore((s) => s.theme === "dark");

  const { data, isLoading, error } = useQuery({
    queryKey: ["overview", days],
    queryFn: () => overviewApi.get({ days }),
  });

  const currency = data?.currency ?? "INR";
  const axisColor = dark ? "#9ca3af" : "#6b7280";
  const gridColor = dark ? "#1f2937" : "#e5e7eb";
  const tooltipStyle = {
    backgroundColor: dark ? "#111827" : "#ffffff",
    border: `1px solid ${gridColor}`,
    borderRadius: 8,
    fontSize: 12,
    color: dark ? "#f3f4f6" : "#111827",
  };

  const chartData =
    data?.daily.map((d: DailyPoint) => ({
      ...d,
      label: shortDate(d.date),
      hours: +(d.total_seconds / 3600).toFixed(2),
    })) ?? [];

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Team Overview
          </h1>
          <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  days === r.days
                    ? "bg-brand-600 text-white"
                    : "bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading && <p className="text-gray-400 text-sm">Loading…</p>}
        {error && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed to load overview"}
          </p>
        )}

        {data && (
          <>
            {/* Headline stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <Stat label="Hours tracked" value={formatHours(data.totals.total_seconds)} sub={`last ${data.days} days`} />
              <Stat label="Billable" value={formatMoney(data.totals.billable_cents, currency)} sub="based on rates" />
              <Stat label="Avg activity" value={`${data.totals.avg_activity}%`} sub="across active days" />
              <Stat label="Active today" value={`${data.totals.active_today}`} sub={`of ${data.totals.employee_count} employees`} />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <Card title="Hours tracked per day">
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                    <XAxis dataKey="label" stroke={axisColor} fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke={axisColor} fontSize={12} tickLine={false} axisLine={false} width={40} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      cursor={{ fill: dark ? "#1f293750" : "#f3f4f680" }}
                      formatter={(v) => [`${v}h`, "Hours"]}
                    />
                    <Bar dataKey="hours" radius={[4, 4, 0, 0]} fill="#0284c7" />
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Average activity per day">
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <defs>
                      <linearGradient id="actFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                    <XAxis dataKey="label" stroke={axisColor} fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke={axisColor} fontSize={12} tickLine={false} axisLine={false} width={40} domain={[0, 100]} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v}%`, "Activity"]} />
                    <Area type="monotone" dataKey="avg_activity" stroke="#0ea5e9" strokeWidth={2} fill="url(#actFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>
            </div>

            {/* Project breakdown + team table */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card title="By project">
                <ProjectBreakdown projects={data.projects} currency={currency} />
              </Card>
              <Card title="By employee">
                <TeamTable employees={data.employees} currency={currency} />
              </Card>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-5 py-4">
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">{title}</h2>
      {children}
    </div>
  );
}

const PROJECT_COLORS = ["#0284c7", "#0ea5e9", "#38bdf8", "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981"];

function ProjectBreakdown({ projects, currency }: { projects: ProjectSummary[]; currency: string }) {
  if (projects.length === 0) {
    return <p className="text-gray-400 text-sm">No tracked time yet.</p>;
  }
  const max = Math.max(...projects.map((p) => p.total_seconds), 1);

  return (
    <div className="space-y-3">
      {projects.map((p, i) => (
        <div key={p.project_id ?? "unassigned"}>
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-gray-700 dark:text-gray-300 truncate">{p.name}</span>
            <span className="text-gray-500 dark:text-gray-400 tabular-nums whitespace-nowrap ml-3">
              {formatHours(p.total_seconds)}
              {p.billable_cents > 0 && (
                <span className="text-gray-400 dark:text-gray-500"> · {formatMoney(p.billable_cents, currency)}</span>
              )}
            </span>
          </div>
          <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(p.total_seconds / max) * 100}%`,
                backgroundColor: PROJECT_COLORS[i % PROJECT_COLORS.length],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function TeamTable({ employees, currency }: { employees: EmployeeSummary[]; currency: string }) {
  if (employees.length === 0) {
    return <p className="text-gray-400 text-sm">No employees yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
            <th className="font-medium pb-2">Employee</th>
            <th className="font-medium pb-2 text-right">Hours</th>
            <th className="font-medium pb-2 text-right">Activity</th>
            <th className="font-medium pb-2 text-right">Billable</th>
            <th className="font-medium pb-2"></th>
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => (
            <tr key={e.user_id} className="border-b border-gray-50 dark:border-gray-800/50 last:border-0">
              <td className="py-3 pr-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${e.can_track ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`}
                    title={e.can_track ? "Tracking on" : "Tracking off"}
                  />
                  <span className="text-gray-900 dark:text-gray-100 truncate">{e.email}</span>
                </div>
              </td>
              <td className="py-3 px-2 text-right tabular-nums text-gray-600 dark:text-gray-300">
                {formatHours(e.total_seconds)}
              </td>
              <td className="py-3 px-2 text-right">
                <span
                  className="inline-block px-2 py-0.5 rounded-full text-xs font-medium text-white"
                  style={{ backgroundColor: activityColor(e.avg_activity) }}
                >
                  {e.avg_activity}%
                </span>
              </td>
              <td className="py-3 px-2 text-right tabular-nums text-gray-700 dark:text-gray-200">
                {formatMoney(e.billable_cents, currency)}
              </td>
              <td className="py-3 pl-2 text-right">
                <Link
                  to={`/diary/${e.user_id}`}
                  className="text-xs text-brand-600 dark:text-brand-400 hover:underline whitespace-nowrap"
                  title="Last active"
                >
                  {relativeTime(e.last_active)} ›
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
