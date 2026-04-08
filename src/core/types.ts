export type StepStatus = "running" | "completed" | "failed";

export interface TestStep {
  id: number;
  action: string;
  description: string;
  status: StepStatus;
  reasoning?: string;
  error?: string;
  timestamp: number;
}

export interface TestAssertion {
  description: string;
  passed: boolean;
  evidence: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  steps: TestStep[];
  assertions: TestAssertion[];
  summary: string;
  duration: number;
}

export interface TestReport {
  url: string;
  scenarios: ScenarioResult[];
  totalDuration: number;
  passedCount: number;
  failedCount: number;
  generatedAt: string;
}

export type SSEEventType =
  | "step"
  | "screenshot"
  | "reasoning"
  | "assertion"
  | "scenario_start"
  | "scenario_complete"
  | "report"
  | "error"
  | "status"
  | "page_discovered"
  | "discovered_cases_chunk"
  | "discovered_cases_complete"
  | "improvement_suggestion";

export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
}

/* ── Database models ────────────────────────────────── */

export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  url: string;
  protocol: string;
  scenarios: string;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  project_id: string;
  user_id: string;
  model: string;
  status: string;
  passed_count: number;
  failed_count: number;
  total_duration: number;
  report_json: string | null;
  created_at: string;
}
