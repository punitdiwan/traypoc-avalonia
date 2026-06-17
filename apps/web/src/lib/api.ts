import type {
  DiaryResponse,
  InvoiceResponse,
  OverviewResponse,
  Project,
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

  logout: async () => {
    await fetch(`${BASE}/auth/logout`, { method: "POST", credentials: "include" });
    localStorage.removeItem("access_token");
  },

  me: () => request<User>("/auth/me"),
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
  addMember: (projectId: string, userId: string) =>
    request<void>(`/projects/${projectId}/members`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
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
  setRate: (userId: string, hourlyRateCents: number) =>
    request<void>(`/users/${userId}/rate`, {
      method: "PATCH",
      body: JSON.stringify({ hourly_rate_cents: hourlyRateCents }),
    }),
  invite: async (email: string, password: string): Promise<User> => {
    // Register the employee, then immediately enable tracking so they can
    // log in on the desktop without a separate employer action.
    const data = await request<{ access_token: string; user: User }>(
      "/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, role: "employee" }) }
    );
    await request<void>(`/users/${data.user.id}/can-track`, {
      method: "PATCH",
      body: JSON.stringify({ can_track: true }),
    });
    return { ...data.user, can_track: true };
  },
};

// Time logs
export const timeLogsApi = {
  list: (date?: string) =>
    request<TimeLog[]>(`/time-logs${date ? `?date=${date}` : ""}`),
};

// Diary
export const diaryApi = {
  get: (userId: string, date?: string) =>
    request<DiaryResponse>(`/diary/${userId}${date ? `?date=${date}` : ""}`),
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
