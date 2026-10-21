/**
 * Cross-machine handoff export (docs/same-machine-instance-handoff.md §2.1).
 * A stop may ask the Run's daemon to push its whole checkout, committed or
 * not, to a branch in this namespace, so a successor on another machine can
 * continue from it. The daemon refuses any other branch.
 */
export const HANDOFF_BRANCH_PREFIX = "xmatrix/handoff/";

export interface MachineHandoffExport {
  branch: string;
  /** The Channel whose Space's GitHub connection authorizes the push. */
  channelId: string;
}

export interface MachineHandoffExportResult {
  branch: string;
  state: "pushed" | "failed";
  commit?: string;
  /** The commit the checkout was on before its uncommitted work was added. */
  base?: string;
  /** Whether uncommitted changes were captured in `commit`. */
  dirty: boolean;
  error?: string;
}

/**
 * A handoff carries the predecessor's conversation, whatever its harness or
 * model. The stop asks the source's daemon to export it; the daemon reads its
 * harness's own transcript and keeps harness-neutral entries (no vendor tool
 * blocks, reasoning or signatures) within `maxChars`. The successor reads them
 * as untrusted prior context and never resumes the predecessor's session.
 */
export const HANDOFF_CONTEXT_FORMAT = "xmatrix.handoff-context.v1";
/** How much conversation a handoff carries: the first request and the newest entries. */
export const HANDOFF_CONTEXT_MAX_CHARS = 60_000;

export interface MachineHandoffContextRequest {
  maxChars: number;
}

export interface MachineHandoffContextEntry {
  role: "user" | "assistant" | "tool_call" | "tool_result";
  tool?: string;
  text: string;
}

export interface MachineHandoffContext {
  format: typeof HANDOFF_CONTEXT_FORMAT;
  /** `claude`, `codex` or `grok`; absent when no session was found. */
  harness?: string;
  sessionId?: string;
  entries: MachineHandoffContextEntry[];
  /** Entries left out to stay within the requested size. */
  omittedEntries: number;
  /** Why there is no conversation, when there is none. */
  error?: string;
}
