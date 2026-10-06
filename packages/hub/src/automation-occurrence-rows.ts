/** Automation and occurrence rows as the PostgreSQL scheduler reads them. */

export const AUTOMATION_OCCURRENCE_BATCH_SIZE = 4;

export type AuthoritySqlValue = ArrayBuffer | string | number | null;

export type AuthoritySqlRow = Record<string, AuthoritySqlValue>;

export interface AutomationExecutionRow extends AuthoritySqlRow {
  id: string;
  owner_user_id: string;
  channel_id: string;
  next_run_at: string;
  enabled: number;
  version: number;
  payload_json: string;
  run_count: number;
  last_run_at: string | null;
  last_run_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationOccurrenceRow extends AuthoritySqlRow {
  id: string;
  task_id: string;
  task_version: number;
  owner_user_id: string;
  scheduled_for: string;
  status: "pending" | "leased" | "prepared" | "dispatched" | "failed" | "cancelled";
  lease_owner: string | null;
  lease_until: string | null;
  attempts: number;
  next_attempt_at: string;
  run_id: string;
  instance_id: string;
  control_id: string;
  delivery_kind: "agent_run" | "message";
  message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  execution_timeout_ms: number;
  execution_deadline_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
