import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import NavBar from "@/components/NavBar";
import { projectsApi, usersApi } from "@/lib/api";
import type { Project, Task, User } from "@/types";

export default function DashboardPage() {
  const qc = useQueryClient();
  const [newProject, setNewProject] = useState("");
  const [error, setError] = useState("");

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: projectsApi.list,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => projectsApi.create(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setNewProject("");
      setError("");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Failed"),
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProject.trim()) return;
    createMutation.mutate(newProject.trim());
  };

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Projects</h1>

        {/* Create project */}
        <form onSubmit={handleCreate} className="flex gap-3 mb-8">
          <input
            type="text"
            placeholder="New project name…"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
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
          <p className="text-gray-400 text-sm">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="text-gray-400 text-sm">No projects yet.</p>
        ) : (
          <div className="space-y-3">
            {projects.map((p: Project) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}

        <EmployeesSection />
      </main>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ["tasks", project.id],
    queryFn: () => projectsApi.listTasks(project.id),
  });

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-medium text-gray-900">{project.name}</h2>
        <Link
          to={`/diary/${project.owner_id}`}
          className="text-xs text-brand-600 hover:underline"
        >
          View diary
        </Link>
      </div>
      <p className="text-xs text-gray-400">
        {tasks.length} task{tasks.length !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

function EmployeesSection() {
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

  const inviteMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      usersApi.invite(email, password),
    onSuccess: (user) => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      setEmail("");
      setPassword("");
      setInviteError("");
      setSuccessMsg(`${user.email} invited — tracking enabled.`);
      setTimeout(() => setSuccessMsg(""), 4000);
    },
    onError: (e) => setInviteError(e instanceof Error ? e.message : "Invite failed"),
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
        <h2 className="text-2xl font-semibold text-gray-900">Employees</h2>
      </div>

      {/* Invite form */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <h3 className="text-sm font-medium text-gray-700 mb-4">Invite Employee</h3>
        <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            required
            placeholder="employee@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <input
            type="password"
            required
            placeholder="Temporary password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            type="submit"
            disabled={inviteMutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {inviteMutation.isPending ? "Inviting…" : "Invite"}
          </button>
        </form>
        {inviteError && (
          <p className="text-sm text-red-600 mt-3">{inviteError}</p>
        )}
        {successMsg && (
          <p className="text-sm text-green-600 mt-3">{successMsg}</p>
        )}
      </div>

      {/* Employee list */}
      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : employees.length === 0 ? (
        <p className="text-gray-400 text-sm">No employees yet. Invite one above.</p>
      ) : (
        <div className="space-y-3">
          {employees.map((emp) => (
            <div
              key={emp.id}
              className="bg-white rounded-xl border border-gray-200 p-5 flex items-center justify-between"
            >
              <div>
                <p className="font-medium text-gray-900 text-sm">{emp.email}</p>
                <Link
                  to={`/diary/${emp.id}`}
                  className="text-xs text-brand-600 hover:underline"
                >
                  View diary
                </Link>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-medium ${emp.can_track ? "text-green-600" : "text-gray-400"}`}>
                  {emp.can_track ? "Tracking on" : "Tracking off"}
                </span>
                <button
                  onClick={() =>
                    toggleMutation.mutate({ id: emp.id, canTrack: !emp.can_track })
                  }
                  disabled={toggleMutation.isPending}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${
                    emp.can_track ? "bg-brand-600" : "bg-gray-200"
                  }`}
                  title={emp.can_track ? "Disable tracking" : "Enable tracking"}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                      emp.can_track ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
