import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import NavBar from "@/components/NavBar";
import NameEditor from "@/components/NameEditor";
import EmployeeComms from "@/components/EmployeeComms";
import { Skeleton } from "@/components/Skeleton";
import { appCategoriesApi, overviewApi, projectsApi, usersApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import { useToastStore } from "@/lib/toast";
import { displayName, formatDuration as fmtHours, formatMoney, MAX_NAME_LEN, normalizeName, toCents } from "@/lib/format";
import type { AppCategory, AppSeen, Project, ProjectMember, Task, User } from "@/types";

const inputClass =
  "border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 placeholder:text-gray-400 dark:placeholder:text-gray-500";

function useCurrency(): string {
  const { data } = useQuery({
    queryKey: ["overview", 1],
    queryFn: () => overviewApi.get({ days: 1 }),
  });
  return data?.currency ?? "INR";
}

export default function ManagePage() {
  const qc = useQueryClient();
  const currency = useCurrency();
  const addToast = useToastStore((s) => s.addToast);
  const [newProject, setNewProject] = useState("");
  const [newRate, setNewRate] = useState("");
  const [error, setError] = useState("");

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: projectsApi.list,
  });

  const createMutation = useMutation({
    mutationFn: ({ name, rateCents }: { name: string; rateCents: number }) =>
      projectsApi.create(name, rateCents),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setNewProject("");
      setNewRate("");
      setError("");
      addToast("Project created successfully");
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "Failed to create project";
      setError(msg);
      addToast(msg, "error");
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProject.trim()) return;
    createMutation.mutate({ name: newProject.trim(), rateCents: toCents(newRate) });
  };

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-6">Projects</h1>

        <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-3 mb-8">
          <input
            type="text"
            placeholder="New project name…"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            className={`flex-1 ${inputClass}`}
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Rate / hr (optional)"
            value={newRate}
            onChange={(e) => setNewRate(e.target.value)}
            className={`w-44 ${inputClass}`}
          />
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </button>
        </form>
        {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        ) : projects.length === 0 ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">No projects yet.</p>
        ) : (
          <div className="space-y-3">
            {projects.map((p: Project) => (
              <ProjectCard key={p.id} project={p} currency={currency} />
            ))}
          </div>
        )}

        <EmployeesSection currency={currency} />
        <AppCategoriesSection />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project card (NameEditor stays here — project names are fine to inline-edit)
// ---------------------------------------------------------------------------

function ProjectCard({ project, currency }: { project: Project; currency: string }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ["tasks", project.id],
    queryFn: () => projectsApi.listTasks(project.id),
  });

  const updateMutation = useMutation({
    mutationFn: (patch: { name?: string; hourly_rate_cents?: number; budget_cents?: number }) =>
      projectsApi.update(project.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      addToast("Project updated");
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Update failed", "error"),
  });

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <div className="flex items-center justify-between mb-2">
        <NameEditor
          value={project.name}
          fallback="Unnamed Project"
          pending={updateMutation.isPending}
          onSave={(name) => updateMutation.mutate({ name })}
          className="font-medium text-gray-900 dark:text-gray-100"
        />
        <Link
          to={`/diary/${project.owner_id}`}
          className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
        >
          View diary
        </Link>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {tasks.length} task{tasks.length !== 1 ? "s" : ""}
        </p>
        <RateEditor
          valueCents={project.hourly_rate_cents}
          currency={currency}
          pending={updateMutation.isPending}
          onSave={(cents) => updateMutation.mutate({ hourly_rate_cents: cents })}
        />
      </div>

      <BudgetSection
        budgetCents={project.budget_cents}
        consumedCents={project.consumed_cents}
        currency={currency}
        pending={updateMutation.isPending}
        onSave={(cents) => updateMutation.mutate({ budget_cents: cents })}
      />

      <MembersEditor projectId={project.id} />
    </div>
  );
}

// Budget progress + inline editor. Warns at 80% (amber) and 100% (red).
function BudgetSection({
  budgetCents, consumedCents, currency, pending, onSave,
}: {
  budgetCents: number; consumedCents: number; currency: string; pending: boolean; onSave: (cents: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const hasBudget = budgetCents > 0;
  const pct = hasBudget ? Math.round((consumedCents / budgetCents) * 100) : 0;
  const over = pct >= 100;
  const warn = pct >= 80 && pct < 100;

  const barColor = over ? "bg-red-500" : warn ? "bg-amber-500" : "bg-brand-600";
  const pctLabelColor = over
    ? "text-red-600 dark:text-red-400"
    : warn
    ? "text-amber-600 dark:text-amber-400"
    : "text-gray-500 dark:text-gray-400";

  const startEdit = () => { setDraft(hasBudget ? String(budgetCents / 100) : ""); setEditing(true); };
  const commit = () => { onSave(toCents(draft)); setEditing(false); };

  return (
    <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">Budget</p>
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              type="number" min="0" step="0.01" autoFocus value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
              className="w-28 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Budget"
            />
            <button onClick={commit} disabled={pending} className="text-xs text-brand-600 dark:text-brand-400 hover:underline disabled:opacity-50">Save</button>
            <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
          </div>
        ) : (
          <button onClick={startEdit} className="text-xs text-gray-500 dark:text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
            {hasBudget ? `${formatMoney(consumedCents, currency)} / ${formatMoney(budgetCents, currency)}` : "Set budget"}
          </button>
        )}
      </div>

      {hasBudget && (
        <>
          <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className={`text-[11px] font-medium ${pctLabelColor}`}>{pct}% used</span>
            {over && (
              <span className="text-[11px] font-semibold text-red-600 dark:text-red-400">
                ⚠ Over budget by {formatMoney(consumedCents - budgetCents, currency)}
              </span>
            )}
            {warn && (
              <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                ⚠ Approaching budget
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MembersEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState("");
  const { data: members = [] } = useQuery<ProjectMember[]>({
    queryKey: ["project-members", projectId],
    queryFn: () => projectsApi.listMembers(projectId),
  });
  const { data: employees = [] } = useQuery<User[]>({
    queryKey: ["employees"],
    queryFn: usersApi.list,
  });
  const addToast = useToastStore((s) => s.addToast);

  const addMutation = useMutation({
    mutationFn: (userId: string) => projectsApi.addMember(projectId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-members", projectId] });
      addToast("Employee assigned to project");
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Assignment failed", "error"),
  });
  const removeMutation = useMutation({
    mutationFn: (userId: string) => projectsApi.removeMember(projectId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project-members", projectId] });
      addToast("Employee removed from project");
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Removal failed", "error"),
  });

  const memberIds = new Set(members.map((m) => m.id));
  const assignable = employees.filter((e) => !memberIds.has(e.id));

  return (
    <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-3">
      <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">
        Assigned employees
      </p>
      {members.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">No one assigned yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2 mb-2">
          {members.map((m) => (
            <span
              key={m.id}
              className="inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-full pl-2.5 pr-1.5 py-1"
              title={m.email}
            >
              {displayName(m)}
              <button
                onClick={() => removeMutation.mutate(m.id)}
                disabled={removeMutation.isPending}
                className="text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
                title={`Remove ${displayName(m)}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {assignable.length > 0 && (
        <select
          value={adding}
          onChange={(e) => {
            const id = e.target.value;
            if (id) { addMutation.mutate(id); setAdding(""); }
          }}
          disabled={addMutation.isPending}
          className="text-xs border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
        >
          <option value="">+ Assign employee…</option>
          {assignable.map((e) => (
            <option key={e.id} value={e.id}>{displayName(e)}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function RateEditor({
  valueCents, currency, pending, onSave,
}: {
  valueCents: number; currency: string; pending: boolean; onSave: (cents: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!editing) {
    return (
      <button
        onClick={() => { setDraft(valueCents ? String(valueCents / 100) : ""); setEditing(true); }}
        className="text-xs text-gray-500 dark:text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
        title="Edit billable rate"
      >
        {valueCents > 0 ? `${formatMoney(valueCents, currency)}/hr` : "Set rate"}
      </button>
    );
  }

  const commit = () => { onSave(toCents(draft)); setEditing(false); };

  return (
    <div className="flex items-center gap-1">
      <input
        type="number" min="0" step="0.01" autoFocus value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className="w-24 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
        placeholder="/ hr"
      />
      <button onClick={commit} disabled={pending} className="text-xs text-brand-600 dark:text-brand-400 hover:underline disabled:opacity-50">Save</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Employees section
// ---------------------------------------------------------------------------

function empInitials(emp: User): string {
  if (emp.full_name?.trim()) {
    return emp.full_name.trim().split(/\s+/).map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  }
  return emp.email[0].toUpperCase();
}

function EmployeesSection({ currency }: { currency: string }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const currentUser = useAuthStore((s) => s.user);
  const isGod = currentUser?.role === "god";
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [editing, setEditing] = useState<User | null>(null);

  const { data: employees = [], isLoading } = useQuery<User[]>({
    queryKey: ["employees"],
    queryFn: usersApi.list,
  });

  // Keep modal in sync if the underlying employee data updates while it's open.
  useEffect(() => {
    if (!editing) return;
    const fresh = employees.find((e) => e.id === editing.id);
    if (fresh) setEditing(fresh);
  }, [employees]); // eslint-disable-line react-hooks/exhaustive-deps

  const inviteMutation = useMutation({
    mutationFn: ({ name, email, password }: { name: string; email: string; password: string }) =>
      usersApi.invite(name, email, password),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      setFullName(""); setEmail(""); setPassword(""); setInviteError("");
      setSuccessMsg(`${variables.name} invited — tracking enabled.`);
      addToast("Employee invited");
      setTimeout(() => setSuccessMsg(""), 4000);
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "Invite failed";
      setInviteError(msg);
      addToast(msg, "error");
    },
  });

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    const name = normalizeName(fullName);
    if (!name || !email.trim() || !password.trim()) return;
    setInviteError("");
    inviteMutation.mutate({ name, email: email.trim(), password });
  };

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Employees</h2>
      </div>

      {/* Invite form */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 mb-6">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">Invite Employee</h3>
        <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
          <input type="text" required maxLength={MAX_NAME_LEN} placeholder="Full name" value={fullName}
            onChange={(e) => setFullName(e.target.value)} className={`flex-1 ${inputClass}`} />
          <input type="email" required placeholder="employee@company.com" value={email}
            onChange={(e) => setEmail(e.target.value)} className={`flex-1 ${inputClass}`} />
          <input type="password" required placeholder="Temporary password" value={password}
            onChange={(e) => setPassword(e.target.value)} className={`flex-1 ${inputClass}`} />
          <button type="submit" disabled={inviteMutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors disabled:opacity-50 whitespace-nowrap">
            {inviteMutation.isPending ? "Inviting…" : "Invite"}
          </button>
        </form>
        {inviteError && <p className="text-sm text-red-600 mt-3">{inviteError}</p>}
        {successMsg && <p className="text-sm text-green-600 mt-3">{successMsg}</p>}
      </div>

      {/* Employee list */}
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : employees.length === 0 ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm">No employees yet. Invite one above.</p>
      ) : (
        <div className="space-y-2">
          {employees.map((emp) => (
            <div
              key={emp.id}
              className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-5 py-4 flex items-center gap-4"
            >
              {/* Avatar */}
              <div className="h-9 w-9 shrink-0 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center text-brand-700 dark:text-brand-400 font-semibold text-sm select-none">
                {empInitials(emp)}
              </div>

              {/* Identity */}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900 dark:text-gray-100 text-sm truncate">
                  {displayName(emp)}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{emp.email}</p>
              </div>

              {/* Status badges */}
              <div className="hidden sm:flex items-center gap-2 shrink-0">
                {isGod && emp.org_name && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 max-w-[120px] truncate" title={emp.org_name}>
                    🏢 {emp.org_name}
                  </span>
                )}
                <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                  emp.can_track
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${emp.can_track ? "bg-green-500" : "bg-gray-400"}`} />
                  {emp.can_track ? "Tracking" : "Paused"}
                </span>
                {emp.require_notes && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                    Notes req.
                  </span>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 shrink-0">
                <EmployeeComms userId={emp.id} name={displayName(emp)} />
                <Link
                  to={`/diary/${emp.id}`}
                  className="text-xs text-brand-600 dark:text-brand-400 hover:underline whitespace-nowrap"
                >
                  View diary
                </Link>
                <Link
                  to={`/timesheets?employee=${emp.id}&name=${encodeURIComponent(displayName(emp))}`}
                  className="text-xs text-brand-600 dark:text-brand-400 hover:underline whitespace-nowrap"
                >
                  Timesheets
                </Link>
                <button
                  onClick={() => setEditing(emp)}
                  title="Edit employee details"
                  className="h-8 w-8 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-brand-600 hover:border-brand-300 dark:hover:text-brand-400 dark:hover:border-brand-700 transition-colors"
                >
                  {/* Pencil icon */}
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
                    <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.714 1.268L5.5 10.25a.75.75 0 0 0 .914.914l2.208-.536a2.75 2.75 0 0 0 1.268-.714l4.261-4.263a1.75 1.75 0 0 0 0-2.475l-.663-.663ZM3.75 12.5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Z" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <EditEmployeeModal
          emp={editing}
          currency={currency}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Edit Employee modal
// ---------------------------------------------------------------------------

function Toggle({
  label, description, checked, onChange, color = "brand",
}: {
  label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; color?: "brand" | "amber";
}) {
  const track = checked
    ? color === "amber" ? "bg-amber-500" : "bg-brand-600"
    : "bg-gray-200 dark:bg-gray-700";
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
        {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${track}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${checked ? "translate-x-5" : "translate-x-0"}`} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App Categories section — employer tags apps as productive/neutral/unproductive
// ---------------------------------------------------------------------------

const CATEGORY_META: Record<AppCategory, { label: string; cls: string }> = {
  productive:   { label: "Productive",   cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  neutral:      { label: "Neutral",      cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  unproductive: { label: "Unproductive", cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
};

function AppCategoriesSection() {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  const { data: apps = [], isLoading } = useQuery<AppSeen[]>({
    queryKey: ["app-categories"],
    queryFn: appCategoriesApi.list,
  });

  const upsertMutation = useMutation({
    mutationFn: ({ appName, category }: { appName: string; category: string }) =>
      appCategoriesApi.upsert(appName, category),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["app-categories"] }); },
    onError: (e) => addToast(e instanceof Error ? e.message : "Update failed", "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (appName: string) => appCategoriesApi.delete(appName),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["app-categories"] }); },
    onError: (e) => addToast(e instanceof Error ? e.message : "Update failed", "error"),
  });

  if (isLoading || apps.length === 0) return null;

  return (
    <section className="mt-10">
      <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-2">App Tracking</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        Tag applications as productive, neutral, or unproductive to compute productivity scores.
      </p>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800/50 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <th className="px-4 py-3 text-left font-medium">Application</th>
              <th className="px-4 py-3 text-left font-medium">Time logged</th>
              <th className="px-4 py-3 text-left font-medium">Category</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {apps.map((app) => (
              <tr key={app.app_name} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-200">{app.app_name}</td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{fmtHours(app.total_seconds)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {app.category && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${CATEGORY_META[app.category].cls}`}>
                        {CATEGORY_META[app.category].label}
                      </span>
                    )}
                    <select
                      value={app.category ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "") {
                          deleteMutation.mutate(app.app_name);
                        } else {
                          upsertMutation.mutate({ appName: app.app_name, category: val });
                        }
                      }}
                      disabled={upsertMutation.isPending || deleteMutation.isPending}
                      className="text-xs border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
                    >
                      <option value="">— Uncategorized —</option>
                      <option value="productive">Productive</option>
                      <option value="neutral">Neutral</option>
                      <option value="unproductive">Unproductive</option>
                    </select>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EditEmployeeModal({ emp, currency, onClose }: { emp: User; currency: string; onClose: () => void }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  // Local draft state for fields that need a "Save" action.
  const [name, setName] = useState(emp.full_name ?? "");
  const [rateDraft, setRateDraft] = useState(emp.hourly_rate_cents ? String(emp.hourly_rate_cents / 100) : "");
  const [saving, setSaving] = useState(false);

  // Break policy drafts (saved together via "Save changes").
  const [breaksEnabled, setBreaksEnabled] = useState(emp.breaks_enabled);
  const [breakDuration, setBreakDuration] = useState(String(emp.break_duration_minutes || 15));
  const [breaksPerDay, setBreaksPerDay] = useState(String(emp.breaks_per_day || 0));
  const [breakDailyMinutes, setBreakDailyMinutes] = useState(String(emp.break_daily_minutes || 0));

  // Close on Escape.
  const backdropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  // Individual toggle mutations — fire immediately.
  const toggleMutation = useMutation({
    mutationFn: (v: boolean) => usersApi.setCanTrack(emp.id, v),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ["employees"] }); addToast(v ? "Tracking enabled" : "Tracking disabled"); },
    onError: (e) => addToast(e instanceof Error ? e.message : "Update failed", "error"),
  });
  const manualMutation = useMutation({
    mutationFn: (v: boolean) => usersApi.setAllowManualTime(emp.id, v),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ["employees"] }); addToast(v ? "Manual time enabled" : "Manual time disabled"); },
    onError: (e) => addToast(e instanceof Error ? e.message : "Update failed", "error"),
  });
  const deleteMutation = useMutation({
    mutationFn: (v: boolean) => usersApi.setAllowDelete(emp.id, v),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ["employees"] }); addToast(v ? "Screenshot deletion enabled" : "Screenshot deletion disabled"); },
    onError: (e) => addToast(e instanceof Error ? e.message : "Update failed", "error"),
  });
  const requireNotesMutation = useMutation({
    mutationFn: (v: boolean) => usersApi.setRequireNotes(emp.id, v),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ["employees"] }); addToast(v ? "Working notes required" : "Working notes optional"); },
    onError: (e) => addToast(e instanceof Error ? e.message : "Update failed", "error"),
  });
  const releaseMutation = useMutation({
    mutationFn: () => usersApi.release(emp.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      addToast("Employee released");
      onClose();
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Release failed", "error"),
  });

  const handleSave = async () => {
    const normalized = normalizeName(name);
    if (!normalized) { addToast("Name cannot be blank", "error"); return; }
    const cents = toCents(rateDraft);
    setSaving(true);
    try {
      const tasks: Promise<unknown>[] = [];
      if (normalized !== emp.full_name) tasks.push(usersApi.setName(emp.id, normalized));
      if (cents !== emp.hourly_rate_cents) tasks.push(usersApi.setRate(emp.id, cents));

      const dur = Math.max(0, parseInt(breakDuration, 10) || 0);
      const perDay = Math.max(0, parseInt(breaksPerDay, 10) || 0);
      const dailyMin = Math.max(0, parseInt(breakDailyMinutes, 10) || 0);
      if (breaksEnabled && dur <= 0) {
        addToast("Break duration must be greater than 0", "error");
        setSaving(false);
        return;
      }
      const breaksChanged =
        breaksEnabled !== emp.breaks_enabled ||
        dur !== emp.break_duration_minutes ||
        perDay !== emp.breaks_per_day ||
        dailyMin !== emp.break_daily_minutes;
      if (breaksChanged) {
        tasks.push(
          usersApi.setBreaks(emp.id, {
            breaks_enabled: breaksEnabled,
            break_duration_minutes: dur,
            breaks_per_day: perDay,
            break_daily_minutes: dailyMin,
          })
        );
      }

      await Promise.all(tasks);
      qc.invalidateQueries({ queryKey: ["employees"] });
      if (tasks.length > 0) addToast("Employee updated");
      onClose();
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Update failed", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center text-brand-700 dark:text-brand-400 font-semibold text-sm">
              {emp.full_name?.trim()
                ? emp.full_name.trim().split(/\s+/).map((n) => n[0]).join("").slice(0, 2).toUpperCase()
                : emp.email[0].toUpperCase()}
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Edit Employee</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">{emp.email}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Profile fields */}
          <div className="px-6 py-5 space-y-4 border-b border-gray-100 dark:border-gray-800">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Profile</p>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Full name</label>
              <input
                type="text"
                value={name}
                maxLength={MAX_NAME_LEN}
                onChange={(e) => setName(e.target.value)}
                className={inputClass + " w-full"}
                placeholder="Full name"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
              <p className="text-sm text-gray-500 dark:text-gray-400 py-2">{emp.email}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Organization</label>
              {emp.org_name ? (
                <p className="text-sm text-gray-700 dark:text-gray-300 py-2 flex items-center gap-1.5">
                  <span>🏢</span>
                  <span>{emp.org_name}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-400 dark:text-gray-500 py-2 italic">
                  Not assigned to any organization
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                Default billable rate ({currency}/hr)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={rateDraft}
                onChange={(e) => setRateDraft(e.target.value)}
                className={inputClass + " w-full"}
                placeholder="0.00"
              />
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Overridden by the project rate when set.
              </p>
            </div>
          </div>

          {/* Permissions */}
          <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-800">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">Permissions</p>
            <Toggle
              label="Allow tracking"
              description="Employee can capture screenshots and log time."
              checked={emp.can_track}
              onChange={(v) => toggleMutation.mutate(v)}
            />
            <Toggle
              label="Allow manual time"
              description="Employee can log time without a screenshot."
              checked={emp.allow_manual_time}
              onChange={(v) => manualMutation.mutate(v)}
            />
            <Toggle
              label="Allow deleting logs"
              description="Employee can delete their own screenshots and tracked time."
              checked={emp.allow_delete}
              onChange={(v) => deleteMutation.mutate(v)}
            />
            <Toggle
              label="Require working notes"
              description="Employee must enter notes on every captured interval."
              checked={emp.require_notes}
              onChange={(v) => requireNotesMutation.mutate(v)}
              color="amber"
            />
          </div>

          {/* Breaks */}
          <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-800">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">Breaks</p>
            <Toggle
              label="Allow breaks"
              description="Employee can pause tracking for a fixed break; it auto-resumes when time is up."
              checked={breaksEnabled}
              onChange={setBreaksEnabled}
            />
            {breaksEnabled && (
              <div className="grid grid-cols-3 gap-3 pt-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Duration (min)</label>
                  <input
                    type="number" min="1"
                    value={breakDuration}
                    onChange={(e) => setBreakDuration(e.target.value)}
                    className={inputClass + " w-full"}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Breaks / day</label>
                  <input
                    type="number" min="0"
                    value={breaksPerDay}
                    onChange={(e) => setBreaksPerDay(e.target.value)}
                    className={inputClass + " w-full"}
                  />
                  <p className="text-[10px] text-gray-400 mt-1">0 = unlimited</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Daily total (min)</label>
                  <input
                    type="number" min="0"
                    value={breakDailyMinutes}
                    onChange={(e) => setBreakDailyMinutes(e.target.value)}
                    className={inputClass + " w-full"}
                  />
                  <p className="text-[10px] text-gray-400 mt-1">0 = unlimited</p>
                </div>
              </div>
            )}
          </div>

          {/* Danger zone */}
          <div className="px-6 py-5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-red-400 mb-3">Danger zone</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Releasing an employee removes them from this organization. Their tracked history is preserved. They lose access immediately until re-invited.
            </p>
            <button
              onClick={() => {
                if (window.confirm(`Release ${displayName(emp)} from this organization?`))
                  releaseMutation.mutate();
              }}
              disabled={releaseMutation.isPending}
              className="w-full border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
            >
              {releaseMutation.isPending ? "Releasing…" : "Release from organization"}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
