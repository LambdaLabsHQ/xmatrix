/** Values read by the first-message launch authority and its history projection. */
export interface FirstMessageLaunchChoiceRow {
  [field: string]: unknown;
  channel_id: string;
  message_id: string;
  author_id: string;
  author_kind: "user" | "agent";
  author_user_id: string;
  sent_at: string | Date;
  body_hash: string;
  deadline_at: string | Date;
  choice: "start" | "none" | null;
  chosen_by: "author" | "jev" | null;
  chosen_at: string | Date;
  chosen_harness: string | null;
  open: boolean;
  recommendation: "start" | "none" | null;
  recommended_harness: string | null;
  failure_code: string | null;
}
