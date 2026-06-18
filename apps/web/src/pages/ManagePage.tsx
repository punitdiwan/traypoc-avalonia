import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import NavBar from "@/components/NavBar";
import { overviewApi, projectsApi, usersApi } from "@/lib/api";
import { formatMoney, toCents } from "@/lib/format";
import type { Project, ProjectMember, Task, User } from "@/types";

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
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed"),
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

        {/* Create project */}
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

        {/* Project list */}
        {isLoading ? (
          <p className="text-gray-400 dark:text-gray-500 text-sm">Loading…</p>
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
      </main>
    </div>
  );
}

function ProjectCard({ project, currency }: { project: Project; currency: string }) {
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ["tasks", project.id],
    queryFn: () => projectsApi.listTasks(project.id),
  });

  const rateMutation = useMutation({
    mutationFn: (cents: number) => projectsApi.update(project.id, { hourly_rate_cents: cents }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-medium text-gray-900 dark:text-gray-100">{project.name}</h2>
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
          pending={rateMutation.isPending}
          onSave={(cents) => rateMutation.mutate(cents)}
        />
      </div>

      <MembersEditor projectId={project.id} />
    </div>
  );
}

/** Lists a project's assigned employees and lets the owner add/remove them. */
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

  const addMutation = useMutation({
    mutationFn: (userId: string) => projectsApi.addMember(projectId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-members", projectId] }),
  });
  const removeMutation = useMutation({
    mutationFn: (userId: string) => projectsApi.removeMember(projectId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-members", projectId] }),
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
            >
              {m.email}
              <button
                onClick={() => removeMutation.mutate(m.id)}
                disabled={removeMutation.isPending}
                className="text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
                title={`Remove ${m.email}`}
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
            if (id) {
              addMutation.mutate(id);
              setAdding("");
            }
          }}
          disabled={addMutation.isPending}
          className="text-xs border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
        >
          <option value="">+ Assign employee…</option>
          {assignable.map((e) => (
            <option key={e.id} value={e.id}>
              {e.email}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Inline "rate / hr" display that turns into an editable input on click. */
function RateEditor({
  valueCents,
  currency,
  pending,
  onSave,
}: {
  valueCents: number;
  currency: string;
  pending: boolean;
  onSave: (cents: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(valueCents ? String(valueCents / 100) : "");
          setEditing(true);
        }}
        className="text-xs text-gray-500 dark:text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
        title="Edit billable rate"
      >
        {valueCents > 0 ? `${formatMoney(valueCents, currency)}/hr` : "Set rate"}
      </button>
    );
  }

  const commit = () => {
    onSave(toCents(draft));
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min="0"
        step="0.01"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-24 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
        placeholder="/ hr"
      />
      <button
        onClick={commit}
        disabled={pending}
        className="text-xs text-brand-600 dark:text-brand-400 hover:underline disabled:opacity-50"
      >
        Save
      </button>
    </div>
  );
}

function EmployeesSection({ currency }: { currency: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [inviteError, setInviteError] = useState("");

  const { data: employees = [], isLoading } = useQuery<User[]>({
    queryKey: ["employees"],
    queryFn: usersApi.list,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, canTrack }: { id: string; canTrack: boolean }) =>
      usersApi.setCanTrack(id, canTrack),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["employees"] }),
  });

  const rateMutation = useMutation({
    mutationFn: ({ id, cents }: { id: string; cents: number }) => usersApi.setRate(id, cents),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["employees"] }),
  });

  const inviteMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      usersApi.invite(email, password),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      setEmail("");
      setPassword("");
      setInviteError("");
      setSuccessMsg(`${variables.email} invited — tracking enabled.`);
      setTimeout(() => setSuccessMsg(""), 4000);
    },
    onError: (e) => setInviteError(e instanceof Error ? e.message : "Invite failed"),
  });

  const releaseMutation = useMutation({
    mutationFn: (id: string) => usersApi.release(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    setInviteError("");
    inviteMutation.mutate({ email: email.trim(), password });
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
          <input
            type="email"
            required
            placeholder="employee@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`flex-1 ${inputClass}`}
          />
          <input
            type="password"
            required
            placeholder="Temporary password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`flex-1 ${inputClass}`}
          />
          <button
            type="submit"
            disabled={inviteMutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {inviteMutation.isPending ? "Inviting…" : "Invite"}
          </button>
        </form>
        {inviteError && <p className="text-sm text-red-600 mt-3">{inviteError}</p>}
        {successMsg && <p className="text-sm text-green-600 mt-3">{successMsg}</p>}
      </div>

      {/* Employee list */}
      {isLoading ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm">Loading…</p>
      ) : employees.length === 0 ? (
        <p className="text-gray-400 dark:text-gray-500 text-sm">No employees yet. Invite one above.</p>
      ) : (
        <div className="space-y-3">
          {employees.map((emp) => (
            <div
              key={emp.id}
              className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="font-medium text-gray-900 dark:text-gray-100 text-sm truncate">{emp.email}</p>
                <Link
                  to={`/diary/${emp.id}`}
                  className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
                >
                  View diary
                </Link>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">Default rate</p>
                  <RateEditor
                    valueCents={emp.hourly_rate_cents}
                    currency={currency}
                    pending={rateMutation.isPending}
                    onSave={(cents) => rateMutation.mutate({ id: emp.id, cents })}
                  />
                </div>
                <span className={`text-xs font-medium ${emp.can_track ? "text-green-600 dark:text-green-400" : "text-gray-400 dark:text-gray-500"}`}>
                  {emp.can_track ? "Tracking on" : "Tracking off"}
                </span>
                <button
                  onClick={() => toggleMutation.mutate({ id: emp.id, canTrack: !emp.can_track })}
                  disabled={toggleMutation.isPending}
                  aria-label={emp.can_track ? "Disable tracking" : "Enable tracking"}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${
                    emp.can_track ? "bg-brand-600" : "bg-gray-200 dark:bg-gray-700"
                  }`}
                  title={emp.can_track ? "Disable tracking" : "Enable tracking"}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                      emp.can_track ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        `Release ${emp.email} from this organization? They'll lose access until re-invited (their tracked history is kept).`
                      )
                    )
                      releaseMutation.mutate(emp.id);
                  }}
                  disabled={releaseMutation.isPending}
                  className="text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 transition-colors disabled:opacity-50"
                  title="Remove this employee from your organization"
                >
                  Release
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
