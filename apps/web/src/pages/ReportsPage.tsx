import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import NavBar from "@/components/NavBar";
import { overviewApi } from "@/lib/api";
import { displayName, formatHours, formatMoney, localDateISO, todayISO } from "@/lib/format";

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateISO(d);
}
const today = () => todayISO();

function downloadCSV(filename: string, rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const inputClass =
  "border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 [color-scheme:light] dark:[color-scheme:dark]";

export default function ReportsPage() {
  const [from, setFrom] = useState(() => isoDaysAgo(29));
  const [to, setTo] = useState(today);

  const { data, isLoading, error } = useQuery({
    queryKey: ["report", from, to],
    queryFn: () => overviewApi.get({ from, to }),
  });
  const currency = data?.currency ?? "INR";

  const exportEmployees = () => {
    if (!data) return;
    downloadCSV(`report_employees_${from}_${to}.csv`, [
      ["Employee", "Email", "Hours", "Avg activity %", `Billable (${currency})`],
      ...data.employees.map((e) => [
        displayName(e),
        e.email,
        (e.total_seconds / 3600).toFixed(2),
        e.avg_activity,
        (e.billable_cents / 100).toFixed(2),
      ]),
    ]);
  };

  const exportProjects = () => {
    if (!data) return;
    downloadCSV(`report_projects_${from}_${to}.csv`, [
      ["Project", "Hours", "Avg activity %", `Billable (${currency})`],
      ...data.projects.map((p) => [
        p.name,
        (p.total_seconds / 3600).toFixed(2),
        p.avg_activity,
        (p.billable_cents / 100).toFixed(2),
      ]),
    ]);
  };

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Reports</h1>
          <div className="flex items-end gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400">
              From
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={`block mt-1 ${inputClass}`} />
            </label>
            <label className="text-xs text-gray-500 dark:text-gray-400">
              To
              <input type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} className={`block mt-1 ${inputClass}`} />
            </label>
          </div>
        </div>

        {isLoading && <p className="text-gray-400 text-sm">Loading…</p>}
        {error && (
          <p className="text-sm text-red-600">{error instanceof Error ? error.message : "Failed to load report"}</p>
        )}

        {data && (
          <>
            {/* Totals */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <Stat label="Hours" value={formatHours(data.totals.total_seconds)} />
              <Stat label="Billable" value={formatMoney(data.totals.billable_cents, currency)} />
              <Stat label="Avg activity" value={`${data.totals.avg_activity}%`} />
              <Stat label="Employees" value={`${data.totals.employee_count}`} />
            </div>

            {/* By employee */}
            <Section
              title="By employee"
              onExport={exportEmployees}
              head={["Employee", "Hours", "Activity", "Billable", ""]}
            >
              {data.employees.map((e) => (
                <tr key={e.user_id} className="border-b border-gray-50 dark:border-gray-800/50 last:border-0">
                  <Td><span title={e.email}>{displayName(e)}</span></Td>
                  <Td right>{formatHours(e.total_seconds)}</Td>
                  <Td right>{e.avg_activity}%</Td>
                  <Td right>{formatMoney(e.billable_cents, currency)}</Td>
                  <Td right>
                    <Link
                      to={`/invoice/${e.user_id}?from=${from}&to=${to}`}
                      className="text-xs text-brand-600 dark:text-brand-400 hover:underline whitespace-nowrap"
                    >
                      Invoice ›
                    </Link>
                  </Td>
                </tr>
              ))}
            </Section>

            {/* By project */}
            <Section
              title="By project"
              onExport={exportProjects}
              head={["Project", "Hours", "Activity", "Billable"]}
            >
              {data.projects.map((p) => (
                <tr key={p.project_id ?? "unassigned"} className="border-b border-gray-50 dark:border-gray-800/50 last:border-0">
                  <Td>{p.name}</Td>
                  <Td right>{formatHours(p.total_seconds)}</Td>
                  <Td right>{p.avg_activity}%</Td>
                  <Td right>{formatMoney(p.billable_cents, currency)}</Td>
                </tr>
              ))}
            </Section>
          </>
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

function Section({
  title,
  head,
  onExport,
  children,
}: {
  title: string;
  head: string[];
  onExport: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">{title}</h2>
        <button
          onClick={onExport}
          className="text-xs font-medium text-brand-600 dark:text-brand-400 border border-brand-200 dark:border-brand-900 rounded-lg px-3 py-1.5 hover:bg-brand-50 dark:hover:bg-brand-950/40 transition-colors"
        >
          Export CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
              {head.map((h, i) => (
                <th key={i} className={`font-medium pb-2 ${i > 0 ? "text-right" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td className={`py-3 px-2 text-gray-700 dark:text-gray-200 ${right ? "text-right tabular-nums" : ""}`}>
      {children}
    </td>
  );
}
