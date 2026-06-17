export type Role = "employee" | "employer";

export interface User {
  id: string;
  email: string;
  role: Role;
  can_track: boolean;
  hourly_rate_cents: number;
}

export interface Project {
  id: string;
  name: string;
  owner_id: string;
  hourly_rate_cents: number;
  created_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
}

export interface TimeLog {
  id: string;
  user_id: string;
  project_id: string | null;
  task_id: string | null;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  activity_percent: number;
  screenshot_url: string | null;
  thumbnail_url: string | null;
  window_title: string | null;
  created_at: string;
}

export interface DiarySlot {
  hour: number;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  activity_percent: number;
  screenshot_url: string | null;
  thumbnail_url: string | null;
  window_title: string | null;
  project_id: string | null;
  task_id: string | null;
}

export interface HourBucket {
  hour: number;
  total_seconds: number;
  avg_activity: number;
  slots: DiarySlot[];
}

export interface DiaryResponse {
  user_id: string;
  date: string;
  hours: HourBucket[];
}

export interface DailyPoint {
  date: string;
  total_seconds: number;
  avg_activity: number;
  active_users: number;
  billable_cents: number;
}

export interface EmployeeSummary {
  user_id: string;
  email: string;
  total_seconds: number;
  avg_activity: number;
  can_track: boolean;
  hourly_rate_cents: number;
  billable_cents: number;
  last_active: string | null;
}

export interface ProjectSummary {
  project_id: string | null;
  name: string;
  total_seconds: number;
  avg_activity: number;
  billable_cents: number;
}

export interface OverviewResponse {
  from: string;
  to: string;
  days: number;
  currency: string;
  daily: DailyPoint[];
  employees: EmployeeSummary[];
  projects: ProjectSummary[];
  totals: {
    total_seconds: number;
    avg_activity: number;
    active_today: number;
    employee_count: number;
    billable_cents: number;
  };
}

export interface InvoiceLine {
  project_id: string | null;
  name: string;
  seconds: number;
  rate_cents: number;
  amount_cents: number;
}

export interface InvoiceResponse {
  user_id: string;
  email: string;
  from: string;
  to: string;
  currency: string;
  line_items: InvoiceLine[];
  total_seconds: number;
  total_cents: number;
  generated_at: string;
}
