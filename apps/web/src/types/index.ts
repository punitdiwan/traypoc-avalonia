export type Role = "employee" | "employer" | "god";

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  can_track: boolean;
  allow_manual_time: boolean;
  allow_delete: boolean;
  require_notes: boolean;
  hourly_rate_cents: number;
  breaks_enabled: boolean;
  break_duration_minutes: number;
  breaks_per_day: number;
  break_daily_minutes: number;
  org_id: string | null;
  org_name?: string;
}

export interface ProjectMember {
  id: string;
  email: string;
  full_name: string;
}

export interface OrgSummary {
  id: string;
  name: string;
  owner_email: string;
  owner_full_name: string;
  employee_count: number;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  owner_id: string;
  hourly_rate_cents: number;
  budget_cents: number;
  consumed_cents: number;
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
  app_name: string | null;
  created_at: string;
}

export interface DiarySlot {
  id: string;
  hour: number;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  activity_percent: number;
  screenshot_url: string | null;
  thumbnail_url: string | null;
  window_title: string | null;
  app_name: string | null;
  notes: string | null;
  project_id: string | null;
  task_id: string | null;
}

export type AppCategory = "productive" | "neutral" | "unproductive";

export interface AppSeen {
  app_name: string;
  total_seconds: number;
  category: AppCategory | null;
}

export type TimesheetStatus = "draft" | "submitted" | "approved" | "rejected";

export interface Timesheet {
  id: string;
  user_id: string;
  user_email: string;
  user_full_name: string;
  org_id: string;
  week_start: string;
  week_end: string;
  status: TimesheetStatus;
  employee_note: string | null;
  employer_note: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  auto_approved: boolean;
  created_at: string;
  total_seconds: number;
  total_billable_cents: number;
}

export interface TimesheetPreviewDaily {
  date: string;
  seconds: number;
}

export interface TimesheetPreviewProject {
  project_id: string | null;
  name: string;
  seconds: number;
  billable_cents: number;
}

export interface TimesheetPreviewApp {
  app_name: string;
  seconds: number;
  category: AppCategory | null;
}

export interface TimesheetPreview {
  user_id: string;
  from: string;
  to: string;
  daily_hours: TimesheetPreviewDaily[];
  projects: TimesheetPreviewProject[];
  apps: TimesheetPreviewApp[];
  total_seconds: number;
  total_billable_cents: number;
  currency: string;
}

export interface HourBucket {
  hour: number;
  total_seconds: number;
  avg_activity: number;
  slots: DiarySlot[];
}

export interface DailyDiary {
  date: string;
  hours: HourBucket[];
}

export interface DiaryResponse {
  user_id: string;
  from: string;
  to: string;
  days: DailyDiary[];
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
  full_name: string;
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

export interface InvoiceClaim {
  title: string;
  description: string | null;
  amount_cents: number;
}

export interface InvoiceResponse {
  user_id: string;
  email: string;
  full_name: string;
  from: string;
  to: string;
  currency: string;
  line_items: InvoiceLine[];
  total_seconds: number;
  total_cents: number;
  /** Approved extra claims dated within the range, and their sum. */
  claims: InvoiceClaim[];
  claims_cents: number;
  /** total_cents (time) + claims_cents — the amount actually due. */
  grand_total_cents: number;
  /** true when total_cents is the frozen amount from an approved timesheet. */
  locked: boolean;
  generated_at: string;
}

export type CallStatus = "ringing" | "answered" | "ended" | "missed" | "rejected" | "failed";

export interface Call {
  id: string;
  org_id: string;
  caller_id: string;
  callee_id: string;
  caller_name?: string;
  callee_name?: string;
  status: CallStatus;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  recording_url?: string | null;
}

export interface Message {
  id: string;
  org_id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export type ClaimStatus = "pending" | "approved" | "rejected";

export interface ClaimDocument {
  name: string;
  url: string;
  content_type: string;
}

export interface Claim {
  id: string;
  user_id: string;
  user_email: string;
  user_full_name: string;
  org_id: string;
  title: string;
  description: string | null;
  amount_cents: number;
  status: ClaimStatus;
  documents: ClaimDocument[];
  employer_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
}
