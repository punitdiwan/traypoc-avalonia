import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import NavBar from "@/components/NavBar";
import { Skeleton } from "@/components/Skeleton";
import { timesheetsApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import { useToastStore } from "@/lib/toast";
import { formatDuration as fmtHours, formatMoney, localDateISO } from "@/lib/format";
import type { Timesheet, TimesheetPreview, TimesheetStatus } from "@/types";

// ── date helpers ─────────────────────────────────────────────────────────────

function mondayOfWeek(d = new Date()): string {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  return localDateISO(mon);
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDateISO(d);
}

function fmtWeekRange(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  const sameMonth =
    s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  if (sameMonth) {
    return (
      s.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " – " +
      e.toLocaleDateString(undefined, { day: "numeric", year: "numeric" })
    );
  }
  return (
    s.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " – " +
    e.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  );
}

// ── status badge ─────────────────────────────────────────────────────────────

const STATUS_META: Record<TimesheetStatus, { label: string; cls: string }> = {
  draft:     { label: "Draft",     cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  submitted: { label: "Submitted", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  approved:  { label: "Approved",  cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  rejected:  { label: "Rejected",  cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
};

function StatusBadge({ status, autoApproved }: { status: TimesheetStatus; autoApproved: boolean }) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${meta.cls}`}>
      {meta.label}
      {autoApproved && <span className="text-[10px] opacity-70">(auto)</span>}
    </span>
  );
}

// ── reject modal ──────────────────────────────────────────────────────────────

function RejectModal({
  sheet,
  onConfirm,
  onClose,
  pending,
}: {
  sheet: Timesheet;
  onConfirm: (note: string) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [note, setNote] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.currentTarget === e.target) onClose(); }}
    >
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Reject timesheet</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {sheet.user_full_name || sheet.user_email} &middot;{" "}
              {fmtWeekRange(sheet.week_start, sheet.week_end)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            &#x2715;
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Reason for rejection <span className="text-red-500">*</span>
            </label>
            <textarea
              autoFocus
              rows={3}
              placeholder="Explain what needs to be corrected..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 resize-none placeholder:text-gray-400"
            />
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(note)}
              disabled={!note.trim() || pending}
              className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {pending ? "Rejecting..." : "Reject timesheet"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── shared textarea style ─────────────────────────────────────────────────────

const textareaCls =
  "w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 placeholder:text-gray-400 resize-none";

// ── employee view ─────────────────────────────────────────────────────────────

function EmployeeTimesheets() {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [note, setNote] = useState("");

  const thisWeek = mondayOfWeek();
  const thisWeekEnd = addDays(thisWeek, 6);

  const { data: sheets = [], isLoading } = useQuery<Timesheet[]>({
    queryKey: ["timesheets"],
    queryFn: timesheetsApi.list,
  });

  const thisWeekSheet = sheets.find((s) => s.week_start === thisWeek);
  const pastSheets = sheets.filter((s) => s.week_start !== thisWeek);

  // Pre-fill note from an existing draft or rejected sheet once loaded
  useEffect(() => {
    if (thisWeekSheet?.employee_note && !note) {
      setNote(thisWeekSheet.employee_note);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thisWeekSheet?.id]);

  // Single action: create (idempotent; resets rejected->draft server-side) then submit
  const submitWeekMutation = useMutation({
    mutationFn: async () => {
      const sheet = await timesheetsApi.create(thisWeek, note.trim() || undefined);
      await timesheetsApi.submit(sheet.id, note.trim() || undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      addToast("Timesheet submitted for approval");
      setNote("");
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Failed", "error"),
  });

  const recallMutation = useMutation({
    mutationFn: (id: string) => timesheetsApi.recall(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      addToast("Timesheet recalled to draft");
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Failed", "error"),
  });

  const status = thisWeekSheet?.status;

  const cardBorder =
    status === "rejected"
      ? "border-red-300 dark:border-red-800"
      : status === "approved"
      ? "border-green-200 dark:border-green-900"
      : "border-gray-200 dark:border-gray-800";

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-6">My Timesheets</h1>

      {/* Current week card */}
      <div className={`bg-white dark:bg-gray-900 rounded-xl border p-5 mb-8 ${cardBorder}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium mb-0.5">
              Current week
            </p>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {fmtWeekRange(thisWeek, thisWeekEnd)}
            </p>
          </div>
          <div className="text-right shrink-0">
            {isLoading ? (
              <Skeleton className="h-5 w-20 rounded-full" />
            ) : thisWeekSheet ? (
              <>
                <StatusBadge status={thisWeekSheet.status} autoApproved={thisWeekSheet.auto_approved} />
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {fmtHours(thisWeekSheet.total_seconds)} logged
                </p>
              </>
            ) : (
              <span className="text-xs text-gray-400 dark:text-gray-500">Not submitted</span>
            )}
          </div>
        </div>

        {/* State-driven body */}
        {isLoading ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-9 w-44 rounded-lg" />
          </div>
        ) : status === "submitted" ? (
          <div className="mt-4 space-y-2">
            {thisWeekSheet!.employee_note && (
              <p className="text-sm text-gray-600 dark:text-gray-300 italic bg-gray-50 dark:bg-gray-800/60 rounded-lg px-3 py-2">
                "{thisWeekSheet!.employee_note}"
              </p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Waiting for employer review...
              </span>
              <button
                onClick={() => recallMutation.mutate(thisWeekSheet!.id)}
                disabled={recallMutation.isPending}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 underline underline-offset-2 transition-colors disabled:opacity-50"
              >
                {recallMutation.isPending ? "Recalling..." : "Recall"}
              </button>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Auto-approves Sunday night if employer doesn't act
            </p>
          </div>
        ) : status === "approved" ? (
          <div className="mt-3">
            <p className="text-sm text-green-700 dark:text-green-400">
              {thisWeekSheet!.auto_approved
                ? "Automatically approved after the review period."
                : "Approved by your employer."}
            </p>
            {thisWeekSheet!.employer_note && (
              <p className="text-sm text-gray-600 dark:text-gray-300 mt-2 bg-gray-50 dark:bg-gray-800/60 rounded-lg px-3 py-2">
                <span className="font-medium">Note:</span> {thisWeekSheet!.employer_note}
              </p>
            )}
            <Link
              to={`/invoice/${thisWeekSheet!.user_id}?from=${thisWeekSheet!.week_start}&to=${thisWeekSheet!.week_end}&approved=1`}
              className="inline-block mt-3 text-sm text-brand-600 dark:text-brand-400 hover:underline"
            >
              View invoice &rarr;
            </Link>
          </div>
        ) : status === "rejected" ? (
          <div className="mt-4 space-y-3">
            {thisWeekSheet!.employer_note && (
              <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2.5">
                <p className="text-xs font-semibold text-red-600 dark:text-red-400 mb-0.5 uppercase tracking-wide">
                  Employer feedback
                </p>
                <p className="text-sm text-red-700 dark:text-red-300">{thisWeekSheet!.employer_note}</p>
              </div>
            )}
            <textarea
              rows={2}
              placeholder="Update your note before resubmitting..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={textareaCls}
            />
            <button
              onClick={() => submitWeekMutation.mutate()}
              disabled={submitWeekMutation.isPending}
              className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
            >
              {submitWeekMutation.isPending ? "Resubmitting..." : "Resubmit for approval"}
            </button>
          </div>
        ) : (
          /* draft or no sheet yet */
          <div className="mt-4 space-y-3">
            <textarea
              rows={2}
              placeholder="Optional note to your employer..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={textareaCls}
            />
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => submitWeekMutation.mutate()}
                disabled={submitWeekMutation.isPending}
                className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
              >
                {submitWeekMutation.isPending ? "Submitting..." : "Submit for approval"}
              </button>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Auto-approves Sunday if not reviewed
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Past weeks */}
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
        Past weeks
      </h2>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((n) => <Skeleton key={n} className="h-14 w-full rounded-xl" />)}
        </div>
      ) : pastSheets.length === 0 ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm">No past timesheets yet.</p>
      ) : (
        <div className="space-y-2">
          {pastSheets.map((s) => (
            <div
              key={s.id}
              className={`bg-white dark:bg-gray-900 rounded-xl border px-5 py-3 flex items-center justify-between ${
                s.status === "rejected"
                  ? "border-l-4 border-l-red-400 border-gray-200 dark:border-gray-800"
                  : "border-gray-200 dark:border-gray-800"
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {fmtWeekRange(s.week_start, s.week_end)}
                </p>
                {s.status === "rejected" && s.employer_note && (
                  <p className="text-xs text-red-600 dark:text-red-400 mt-0.5 truncate" title={s.employer_note}>
                    {s.employer_note}
                  </p>
                )}
                {s.status === "approved" && (
                  <Link
                    to={`/invoice/${s.user_id}?from=${s.week_start}&to=${s.week_end}&approved=1`}
                    className="text-xs text-brand-600 dark:text-brand-400 hover:underline mt-0.5 inline-block"
                  >
                    View invoice &rarr;
                  </Link>
                )}
              </div>
              <div className="text-right shrink-0 ml-4">
                <StatusBadge status={s.status} autoApproved={s.auto_approved} />
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{fmtHours(s.total_seconds)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── category badge (used in the app breakdown) ────────────────────────────────

const CATEGORY_META = {
  productive:   { label: "Productive",   cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  neutral:      { label: "Neutral",      cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  unproductive: { label: "Unproductive", cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
} as const;

// Day-of-week labels aligned to ISO Monday = index 0
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ── timesheet detail panel ────────────────────────────────────────────────────

function DetailPanel({ preview, weekStart }: { preview: TimesheetPreview; weekStart: string }) {
  // Build a map date → seconds for the 7-day grid
  const dayMap = Object.fromEntries(preview.daily_hours.map((d) => [d.date, d.seconds]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-4 space-y-5">
      {/* Weekly hours grid */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
          Hours per day
        </p>
        <div className="grid grid-cols-7 gap-1">
          {days.map((date, i) => {
            const secs = dayMap[date] ?? 0;
            const hasWork = secs > 0;
            return (
              <div key={date} className="flex flex-col items-center gap-1">
                <span className="text-[10px] text-gray-400 dark:text-gray-500">{DAY_LABELS[i]}</span>
                <div className={`w-full rounded text-center py-1.5 text-xs font-medium ${
                  hasWork
                    ? "bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400"
                    : "bg-gray-50 dark:bg-gray-800 text-gray-300 dark:text-gray-600"
                }`}>
                  {hasWork ? fmtHours(secs) : "—"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Project breakdown */}
      {preview.projects.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
            Projects
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
                <th className="pb-1 font-medium">Project</th>
                <th className="pb-1 font-medium text-right">Hours</th>
                <th className="pb-1 font-medium text-right">Billable</th>
              </tr>
            </thead>
            <tbody>
              {preview.projects.map((p) => (
                <tr key={p.project_id ?? "none"} className="border-b border-gray-50 dark:border-gray-800/50">
                  <td className="py-1.5 text-gray-800 dark:text-gray-200">{p.name}</td>
                  <td className="py-1.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{fmtHours(p.seconds)}</td>
                  <td className="py-1.5 text-right tabular-nums text-gray-800 dark:text-gray-200">
                    {p.billable_cents > 0 ? formatMoney(p.billable_cents, preview.currency) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Total billable row */}
          <div className="flex justify-between items-center pt-2 border-t border-gray-200 dark:border-gray-700 mt-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              Total · {fmtHours(preview.total_seconds)}
            </span>
            <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
              {formatMoney(preview.total_billable_cents, preview.currency)}
            </span>
          </div>
        </div>
      )}

      {/* App usage */}
      {preview.apps.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
            Applications used
          </p>
          <div className="flex flex-wrap gap-1.5">
            {preview.apps.map((a) => {
              const meta = a.category ? CATEGORY_META[a.category] : null;
              return (
                <span
                  key={a.app_name}
                  title={fmtHours(a.seconds)}
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                    meta ? meta.cls : "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400"
                  }`}
                >
                  {a.app_name}
                  <span className="opacity-60">{fmtHours(a.seconds)}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── pending timesheet card (self-contained: owns the expand/fetch state) ──────

function PendingCard({
  s,
  approvePending,
  onApprove,
  onReject,
}: {
  s: Timesheet;
  approvePending: boolean;
  onApprove: (id: string) => void;
  onReject: (sheet: Timesheet) => void;
}) {
  const [open, setOpen] = useState(false);

  const { data: preview, isLoading: previewLoading } = useQuery<TimesheetPreview>({
    queryKey: ["timesheet-preview", s.user_id, s.week_start, s.week_end],
    queryFn: () => timesheetsApi.preview(s.user_id, s.week_start, s.week_end),
    enabled: open,
    staleTime: 60_000,
  });

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 border-l-4 border-l-amber-400 p-5">
      {/* Card header row */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
            {s.user_full_name || s.user_email}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {fmtWeekRange(s.week_start, s.week_end)} &middot; {fmtHours(s.total_seconds)} logged
          </p>
          {s.employee_note && (
            <p className="text-sm text-gray-600 dark:text-gray-300 italic mt-2 bg-gray-50 dark:bg-gray-800/60 rounded-lg px-3 py-2">
              "{s.employee_note}"
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => onApprove(s.id)}
            disabled={approvePending}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => onReject(s)}
            className="px-3 py-1.5 border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 text-xs font-semibold rounded-lg transition-colors"
          >
            Reject
          </button>
        </div>
      </div>

      {/* Expand/collapse detail toggle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-3 flex items-center gap-1 text-xs text-brand-600 dark:text-brand-400 hover:underline"
      >
        {open ? "Hide details ▲" : "View time & app details ▼"}
      </button>

      {/* Detail panel */}
      {open && (
        previewLoading ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        ) : preview ? (
          <DetailPanel preview={preview} weekStart={s.week_start} />
        ) : null
      )}
    </div>
  );
}

// ── employer view ─────────────────────────────────────────────────────────────

function EmployerTimesheets() {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [rejectTarget, setRejectTarget] = useState<Timesheet | null>(null);
  const [searchParams] = useSearchParams();
  const filterUserId = searchParams.get("employee");
  const filterName = searchParams.get("name");

  const { data: sheets = [], isLoading } = useQuery<Timesheet[]>({
    queryKey: ["timesheets"],
    queryFn: timesheetsApi.list,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => timesheetsApi.approve(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      addToast("Timesheet approved");
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Failed", "error"),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => timesheetsApi.reject(id, note),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timesheets"] });
      addToast("Timesheet rejected");
      setRejectTarget(null);
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Failed", "error"),
  });

  const visible = filterUserId ? sheets.filter((s) => s.user_id === filterUserId) : sheets;
  const pending = visible.filter((s) => s.status === "submitted");
  const history = visible.filter((s) => s.status !== "submitted");
  const pendingHours = pending.reduce((sum, s) => sum + s.total_seconds, 0);

  const employeeName =
    filterName ||
    sheets.find((s) => s.user_id === filterUserId)?.user_full_name ||
    sheets.find((s) => s.user_id === filterUserId)?.user_email ||
    "Employee";

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Timesheets</h1>
        {filterUserId && (
          <Link
            to="/manage"
            className="text-sm text-brand-600 dark:text-brand-400 hover:underline"
          >
            &larr; Back to manage
          </Link>
        )}
      </div>

      {/* Per-employee filter banner */}
      {filterUserId && (
        <div className="flex items-center justify-between mb-5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-2.5">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            Showing timesheets for <span className="font-semibold">{employeeName}</span>
          </p>
          <Link
            to="/timesheets"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Show all employees
          </Link>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((n) => <Skeleton key={n} className="h-24 w-full rounded-xl" />)}
        </div>
      ) : (
        <>
          {/* Pending approvals */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Pending approval
              </h2>
              {pending.length > 0 && (
                <span className="text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 px-2.5 py-0.5 rounded-full">
                  {pending.length} &middot; {fmtHours(pendingHours)}
                </span>
              )}
            </div>

            {pending.length === 0 ? (
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-5 py-8 text-center">
                <p className="text-gray-400 dark:text-gray-500 text-sm">
                  All caught up &mdash; no pending timesheets.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {pending.map((s) => (
                  <PendingCard
                    key={s.id}
                    s={s}
                    approvePending={approveMutation.isPending}
                    onApprove={(id) => approveMutation.mutate(id)}
                    onReject={setRejectTarget}
                  />
                ))}
              </div>
            )}
          </section>

          {/* History */}
          {history.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
                History
              </h2>
              <div className="space-y-2">
                {history.map((s) => (
                  <div
                    key={s.id}
                    className={`bg-white dark:bg-gray-900 rounded-xl border px-5 py-3 ${
                      s.status === "rejected"
                        ? "border-l-4 border-l-red-400 border-gray-200 dark:border-gray-800"
                        : s.status === "approved"
                        ? "border-l-4 border-l-green-400 border-gray-200 dark:border-gray-800"
                        : "border-gray-200 dark:border-gray-800"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {s.user_full_name || s.user_email}
                          <span className="font-normal text-gray-400 dark:text-gray-500 ml-2">
                            {fmtWeekRange(s.week_start, s.week_end)}
                          </span>
                        </p>
                        {s.employer_note && (
                          <p
                            className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate"
                            title={s.employer_note}
                          >
                            Note: {s.employer_note}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <StatusBadge status={s.status} autoApproved={s.auto_approved} />
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                          {fmtHours(s.total_seconds)}
                          {s.status === "approved" && s.total_billable_cents > 0 && (
                            <span className="ml-1 text-green-600 dark:text-green-400 font-medium">
                              &middot; paid
                            </span>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* Approved: show locked billable + invoice link */}
                    {s.status === "approved" && (
                      <div className="mt-2 flex items-center justify-between border-t border-gray-100 dark:border-gray-800 pt-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full">
                            &#10003; PAID
                          </span>
                          {s.total_billable_cents > 0 && (
                            <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
                              {/* currency comes from the preview; we'll show the raw value */}
                              {(s.total_billable_cents / 100).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          )}
                        </div>
                        <Link
                          to={`/invoice/${s.user_id}?from=${s.week_start}&to=${s.week_end}&approved=1`}
                          className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
                        >
                          View invoice &rarr;
                        </Link>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Rejection modal */}
      {rejectTarget && (
        <RejectModal
          sheet={rejectTarget}
          onConfirm={(note) => rejectMutation.mutate({ id: rejectTarget.id, note })}
          onClose={() => setRejectTarget(null)}
          pending={rejectMutation.isPending}
        />
      )}
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────────────

export default function TimesheetsPage() {
  const role = useAuthStore((s) => s.user?.role);
  return (
    <div className="min-h-screen">
      <NavBar />
      {role === "employee" ? <EmployeeTimesheets /> : <EmployerTimesheets />}
    </div>
  );
}
