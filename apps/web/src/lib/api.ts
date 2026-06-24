import type {
  AppSeen,
  Call,
  Claim,
  ClaimDocument,
  DiaryResponse,
  InvoiceResponse,
  Message,
  OrgSummary,
  OverviewResponse,
  Project,
  ProjectMember,
  Task,
  TimeLog,
  Timesheet,
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

// Fetch a binary response (with auth + refresh) and trigger a browser download.
async function downloadFile(path: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers["Authorization"] = `Bearer ${t}`;

  let res = await fetch(`${BASE}${path}`, { headers });
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (!refreshed) {
      localStorage.removeItem("access_token");
      window.location.href = "/login";
      throw new Error("Session expired");
    }
    headers["Authorization"] = `Bearer ${token()}`;
    res = await fetch(`${BASE}${path}`, { headers });
  }
  if (!res.ok) throw new Error(await res.text());

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  update: (projectId: string, patch: { name?: string; hourly_rate_cents?: number; budget_cents?: number }) =>
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
  // Set the per-employee break policy (employer-only).
  setBreaks: (
    userId: string,
    breaks: {
      breaks_enabled: boolean;
      break_duration_minutes: number;
      breaks_per_day: number;
      break_daily_minutes: number;
    }
  ) =>
    request<void>(`/users/${userId}/breaks`, {
      method: "PATCH",
      body: JSON.stringify(breaks),
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
export interface TimeLogPatch {
  project_id?: string | null;
  started_at?: string;
  ended_at?: string;
  notes?: string | null;
}

export const timeLogsApi = {
  list: (date?: string) =>
    request<TimeLog[]>(`/time-logs${date ? `?date=${date}` : ""}`),
  // Delete a single time log (and its screenshot). Allowed for the org owner on any
  // employee, or for the employee themselves when the employer enabled allow_delete.
  delete: (id: string) => request<void>(`/time-logs/${id}`, { method: "DELETE" }),
  // Edit a single time log's project, time window, or notes. Same authorization as
  // delete (employer/god any in org; employee own when allow_delete is on).
  update: (id: string, patch: TimeLogPatch) =>
    request<TimeLog>(`/time-logs/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
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

// Billable invoice / timesheet for one employee.
// Access is enforced server-side: employer/god for any org employee, an
// employee for their own.
export const invoiceApi = {
  get: (userId: string, from: string, to: string, approved = false) =>
    request<InvoiceResponse>(
      `/invoice?user_id=${userId}&from=${from}&to=${to}${approved ? "&approved=1" : ""}`
    ),
  downloadPdf: (
    userId: string,
    from: string,
    to: string,
    opts?: { approved?: boolean }
  ) =>
    downloadFile(
      `/invoice.pdf?user_id=${userId}&from=${from}&to=${to}${opts?.approved ? "&approved=1" : ""}`,
      `invoice-${from}-to-${to}.pdf`
    ),
};

// App categories — employer tags app names as productive/neutral/unproductive
export const appCategoriesApi = {
  list: () => request<AppSeen[]>("/app-categories"),
  upsert: (appName: string, category: string) =>
    request<void>(`/app-categories/${encodeURIComponent(appName)}`, {
      method: "PUT",
      body: JSON.stringify({ category }),
    }),
  delete: (appName: string) =>
    request<void>(`/app-categories/${encodeURIComponent(appName)}`, {
      method: "DELETE",
    }),
};

// Timesheets — weekly approval workflow
export const timesheetsApi = {
  list: () => request<Timesheet[]>("/timesheets"),
  create: (weekStart: string, employeeNote?: string) =>
    request<Timesheet>("/timesheets", {
      method: "POST",
      body: JSON.stringify({ week_start: weekStart, employee_note: employeeNote ?? null }),
    }),
  submit: (id: string, employeeNote?: string) =>
    request<void>(`/timesheets/${id}/submit`, {
      method: "POST",
      body: JSON.stringify({ employee_note: employeeNote ?? null }),
    }),
  recall: (id: string) =>
    request<void>(`/timesheets/${id}/recall`, { method: "POST", body: "{}" }),
  approve: (id: string, employerNote?: string) =>
    request<void>(`/timesheets/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ employer_note: employerNote ?? null }),
    }),
  reject: (id: string, employerNote: string) =>
    request<void>(`/timesheets/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ employer_note: employerNote }),
    }),
  preview: (userId: string, from: string, to: string) =>
    request<import("../types").TimesheetPreview>(
      `/timesheet-preview?user_id=${userId}&from=${from}&to=${to}`
    ),
};

// Presigned uploads — used by Claims to push documents straight to Spaces.
interface PresignSlot {
  key: string;
  put_url: string;
  public_url: string;
  headers: Record<string, string>;
}

export const uploadsApi = {
  presign: (files: { key: string; content_type: string }[]) =>
    request<{ uploads: PresignSlot[] }>("/uploads/presign", {
      method: "POST",
      body: JSON.stringify({ files }),
    }),
};

// Upload a single file to a presigned PUT URL (direct to Spaces, not the API).
async function putToSpaces(slot: PresignSlot, file: File): Promise<void> {
  const res = await fetch(slot.put_url, {
    method: "PUT",
    headers: slot.headers,
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

// Upload claim documents and return their stored references. Each file gets a
// unique key under the caller's prefix; the API content-type is inferred from
// the extension (png/jpg/pdf).
export async function uploadClaimDocuments(files: File[]): Promise<ClaimDocument[]> {
  if (files.length === 0) return [];
  const specs = files.map((f) => {
    const ext = f.name.split(".").pop()?.toLowerCase() || "bin";
    const rand = Math.random().toString(36).slice(2, 10);
    return {
      key: `claims/${Date.now()}-${rand}.${ext}`,
      content_type: f.type || "",
    };
  });
  const { uploads } = await uploadsApi.presign(specs);
  await Promise.all(uploads.map((slot, i) => putToSpaces(slot, files[i])));
  return uploads.map((slot, i) => ({
    name: files[i].name,
    url: slot.public_url,
    content_type: slot.headers["Content-Type"] || files[i].type || "",
  }));
}

// ICE servers for WebRTC (STUN + short-lived TURN credentials).
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export const callsApi = {
  // Call history (employer: any org member or ?user_id; employee: own).
  list: (userId?: string) =>
    request<Call[]>(`/calls${userId ? `?user_id=${userId}` : ""}`),
  iceServers: () => request<{ ice_servers: IceServer[] }>("/turn-credentials"),
  // LiveKit join token for a call's room. `url` is the wss endpoint to connect to.
  livekitToken: (room: string) =>
    request<{ url: string; token: string }>(`/livekit/token?room=${encodeURIComponent(room)}`),
};

export const messagesApi = {
  // Chat history with another user (marks incoming as read server-side).
  list: (withUserId: string) =>
    request<Message[]>(`/messages?with=${withUserId}`),
  // Persist a message; returns the stored row (canonical id/timestamp) which the
  // sender then broadcasts over LiveKit data messaging.
  send: (to: string, body: string) =>
    request<Message>("/messages", { method: "POST", body: JSON.stringify({ to, body }) }),
  // LiveKit join token for the 1:1 chat room. Employees omit `with` (their own
  // inbox); employers pass the employee id.
  token: (withUserId?: string) =>
    request<{ url: string; token: string; room: string }>(
      `/messages/token${withUserId ? `?with=${encodeURIComponent(withUserId)}` : ""}`,
    ),
  // The org's primary employer, so an employee knows who to address.
  admin: () => request<{ id: string; full_name: string; email: string }>("/messages/admin"),
};

export const pushApi = {
  publicKey: () => request<{ public_key: string }>("/push/public-key"),
  subscribe: (sub: PushSubscriptionJSON) =>
    request<void>("/push/subscribe", { method: "POST", body: JSON.stringify(sub) }),
};

// Extra claims — employees raise reimbursement claims; employers approve/reject.
export const claimsApi = {
  list: () => request<Claim[]>("/claims"),
  create: (input: {
    title: string;
    description?: string;
    amount_cents: number;
    documents: ClaimDocument[];
  }) =>
    request<Claim>("/claims", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        description: input.description ?? null,
        amount_cents: input.amount_cents,
        documents: input.documents,
      }),
    }),
  remove: (id: string) => request<void>(`/claims/${id}`, { method: "DELETE" }),
  approve: (id: string, employerNote?: string) =>
    request<void>(`/claims/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ employer_note: employerNote ?? null }),
    }),
  reject: (id: string, employerNote: string) =>
    request<void>(`/claims/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ employer_note: employerNote }),
    }),
};
