export type Role = "employee" | "employer";

export interface User {
  id: string;
  email: string;
  role: Role;
  can_track: boolean;
}

export interface Project {
  id: string;
  name: string;
  owner_id: string;
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
