/**
 * The tag contract shared by every Agent runtime, Hub, and client.
 *
 * Its own module so the tag shape can grow without pushing `authority.ts` past the
 * source line limit.
 */

/**
 * One tag the runtime declares about itself. Clients render the tags they are
 * given and format the numbers; they never derive tags from other fields, so a
 * tag the runtime omits is simply not shown.
 *
 * Time-varying facts travel as numbers (`percent`, `resetAt`), not as
 * pre-rendered text, because a rendered string goes stale on the client.
 */
export interface AgentStatusChip {
  /** Stable chip id within the instance (e.g. `model`, `effort`, `quota:5h`). */
  id: string;
  /** Short human label shown in the header (e.g. `Model`, `Effort`, `5h`). */
  label: string;
  /** Display value (e.g. `gpt-5.4`, `high`). Omitted by meter-only tags. */
  value?: string;
  /** Optional source hint for debugging (e.g. `codex`, `claude`). */
  source?: string;
  /** 0-100 fill for meter tags (quota windows, context). */
  percent?: number;
  /** Instant this window resets, ISO-8601 or epoch seconds, formatted by the client. */
  resetAt?: string;
  /** Set on tags Hub derives from a reported harness parameter; picks the generic parameter icon. */
  parameterKind?: "boolean" | "enum";
}
