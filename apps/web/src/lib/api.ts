import type {
  DiaryResponse,
  InvoiceResponse,
  OrgSummary,
  OverviewResponse,
  Project,
  ProjectMember,
  Task,
  TimeLog,
  User,
} from "@/types";

const BASE = "/api";

function token(): string | null {
  return localStorage.getItem("access_token");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string>),
  };
  const t = token();
  if (t) headers["Authorization"] = `Bearer ${t}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    // Try to refresh; on failure clear state and reload.
    const refreshed = await tryRefresh();
    if (!refreshed) {
      localStorage.removeItem("access_token");
      window.location.href = "/login";
      throw new Error("Session expired");
    }
    headers["Authorization"] = `Bearer ${token()}`;
    const retry = await fetch(`${BASE}${path}`, { ...init, headers });
    if (!retry.ok) throw new Error(await retry.text());
    return retry.json() as Promise<T>;
  }
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

async function tryRefresh(): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) return false;
  const data = await res.json();
  localStorage.setItem("access_token", data.access_token);
  return true;
}

// Auth
export const authApi = {
  login: async (email: string, password: string) => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    localStorage.setItem("access_token", data.access_token);
    return data as { access_token: string; user: User };
  },

  // Self-serve signup: creates a new organization and makes the signer its owner.
  register: async (orgName: string, fullName: string, email: string, password: string) => {
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ org_name: orgName, full_name: fullName, email, password }),
    });
    if (!res.ok) {
      // The API returns {"error": "..."} for the "already a member" conflict.
      const body = await res.text();
      let message = body;
      try {
        message = JSON.parse(body).error || body;
      } catch {
        // not JSON — use the raw body
      }
      throw new Error(message);
    }
    const data = await res.json();
    localStorage.setItem("access_token", data.access_token);
    return data as { access_token: string; user: User };
  },

  logout: async () => {
    await fetch(`${BASE}/auth/logout`, { method: "POST", credentials: "include" });
    localStorage.removeItem("access_token");
  },

  me: () => request<User>("/auth/me"),

  // Self-service: update the signed-in user's own full name.
  updateMe: (fullName: string) =>
    request<void>("/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ full_name: fullName }),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/auth/password", {
      method: "PATCH",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  forgotPassword: async (email: string) => {
    const res = await fetch(`${BASE}/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(await res.text());
  },

  resetPassword: async (token: string, newPassword: string) => {
    const res = await fetch(`${BASE}/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, new_password: newPassword }),
    });
    if (!res.ok) throw new Error(await res.text());
  },
};

// Projects
export const projectsApi = {
  list: () => request<Project[]>("/projects"),
  create: (name: string, hourlyRateCents = 0) =>
    request<{ id: string }>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, hourly_rate_cents: hourlyRateCents }),
    }),
  update: (projectId: string, patch: { name?: string; hourly_rate_cents?: number }) =>
    request<void>(`/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  listTasks: (projectId: string) => request<Task[]>(`/projects/${projectId}/tasks`),
  createTask: (projectId: string, name: string) =>
    request<{ id: string }>(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  listMembers: (projectId: string) =>
    request<ProjectMember[]>(`/projects/${projectId}/members`),
  addMember: (projectId: string, userId: string) =>
    request<void>(`/projects/${projectId}/members`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    }),
  removeMember: (projectId: string, userId: string) =>
    request<void>(`/projects/${projectId}/members/${userId}`, {
      method: "DELETE",
    }),
};

// Users (employer-only)
export const usersApi = {
  list: () => request<User[]>("/users"),
  setCanTrack: (userId: string, canTrack: boolean) =>
    request<void>(`/users/${userId}/can-track`, {
      method: "PATCH",
      body: JSON.stringify({ can_track: canTrack }),
    }),
  setAllowManualTime: (userId: string, allow: boolean) =>
    request<void>(`/users/${userId}/allow-manual-time`, {
      method: "PATCH",
      body: JSON.stringify({ allow_manual_time: allow }),
    }),
  // Allow an employee to delete their own time logs (and screenshots) from the diary.
  setAllowDelete: (userId: string, allow: boolean) =>
    request<void>(`/users/${userId}/allow-delete`, {
      method: "PATCH",
      body: JSON.stringify({ allow_delete: allow }),
    }),
  // Require the employee to enter working notes on every captured interval.
  setRequireNotes: (userId: string, require: boolean) =>
    request<void>(`/users/${userId}/require-notes`, {
      method: "PATCH",
      body: JSON.stringify({ require_notes: require }),
    }),
  setRate: (userId: string, hourlyRateCents: number) =>
    request<void>(`/users/${userId}/rate`, {
      method: "PATCH",
      body: JSON.stringify({ hourly_rate_cents: hourlyRateCents }),
    }),
  // Rename an employee in the caller's organization.
  setName: (userId: string, fullName: string) =>
    request<void>(`/users/${userId}/name`, {
      method: "PATCH",
      body: JSON.stringify({ full_name: fullName }),
    }),
  // Invite an employee into the caller's organization (tracking enabled).
  invite: (fullName: string, email: string, password: string) =>
    request<{ id: string }>("/users", {
      method: "POST",
      body: JSON.stringify({ full_name: fullName, email, password }),
    }),
  // Release an employee from the organization, freeing their email.
  release: (userId: string) =>
    request<void>(`/users/${userId}/org`, { method: "DELETE" }),
};

// God super-admin (cross-organization)
export const adminApi = {
  listOrgs: () => request<OrgSummary[]>("/admin/orgs"),
  createOrg: (
    orgName: string,
    ownerFullName: string,
    ownerEmail: string,
    ownerPassword: string
  ) =>
    request<{ org_id: string; owner_id: string }>("/admin/orgs", {
      method: "POST",
      body: JSON.stringify({
        org_name: orgName,
        owner_full_name: ownerFullName,
        owner_email: ownerEmail,
        owner_password: ownerPassword,
      }),
    }),
};

// Time logs
export const timeLogsApi = {
  list: (date?: string) =>
    request<TimeLog[]>(`/time-logs${date ? `?date=${date}` : ""}`),
  // Delete a single time log (and its screenshot). Allowed for the org owner on any
  // employee, or for the employee themselves when the employer enabled allow_delete.
  delete: (id: string) => request<void>(`/time-logs/${id}`, { method: "DELETE" }),
};

// Diary
export const diaryApi = {
  get: (userId: string, from: string, to: string) =>
    request<DiaryResponse>(`/diary/${userId}?from=${from}&to=${to}`),
};

// Team overview & billable reports (employer-only)
export const overviewApi = {
  get: (params: { days?: number; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.from && params.to) {
      q.set("from", params.from);
      q.set("to", params.to);
    } else {
      q.set("days", String(params.days ?? 7));
    }
    return request<OverviewResponse>(`/overview?${q.toString()}`);
  },
};

// Billable invoice / timesheet for one employee (employer-only)
export const invoiceApi = {
  get: (userId: string, from: string, to: string) =>
    request<InvoiceResponse>(
      `/invoice?user_id=${userId}&from=${from}&to=${to}`
    ),
};
