/** Machine Run startup and stop failures, turned into channel-safe product copy. */

import { publicMachineStartupFailure } from "@xmatrix/protocol";

const MACHINE_RUN_STARTUP_FAILURE_PHASES = new Set([
  "auth_resolving",
  "workspace_registering",
  "relay_registering",
  "relay_register_retrying",
  "relay_auth_refresh_retrying",
  "daemon_auth_refresh_failed",
  "codex_app_starting",
  "wrapper_startup_failed",
]);

const MACHINE_RUN_FAILURE_DETAIL_MAX_CHARS = 2_000;

/** C0 controls and DEL. */
function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

function boundedMachineRunFailureText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = Array.from(value.replace(/\r\n?/gu, "\n"))
    .filter((character) => character === "\t" || character === "\n" || !isControlCharacter(character))
    .join("")
    .trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, MACHINE_RUN_FAILURE_DETAIL_MAX_CHARS).join("");
}

/**
 * Map daemon/runtime failure detail into product copy for channel notices.
 * Never surface raw `git fetch ...` command lines as the primary user text.
 */
export function humanizeMachineRunFailureDetail(detail: string): {
  code: string;
  summary: string;
  action?: string;
} {
  const preparationFailure = publicMachineStartupFailure(detail);
  if (preparationFailure) return preparationFailure;
  const lower = detail.toLowerCase();
  if (
    lower.includes("remote repo worktree unavailable") ||
    (lower.includes("stalled") && lower.includes("git fetch")) ||
    lower.includes("exceeded max fetch time") ||
    (lower.includes("git fetch") && (lower.includes("timed out") || lower.includes("timeout")))
  ) {
    return {
      code: "remote_repo_fetch",
      summary:
        "xMatrix could not finish preparing a fresh copy of the selected repository on that machine before launch.",
      action:
        "Check that machine's network and GitHub access, then try @agent:new again. If a local checkout already exists, summon without re-selecting the remote repo.",
    };
  }
  if (
    lower.includes("is not accessible") ||
    lower.includes("remote repository") && lower.includes("not accessible")
  ) {
    return {
      code: "remote_repo_access",
      summary: "That machine cannot access the selected repository.",
      action:
        "Confirm GitHub authentication on the machine (for example `gh auth status`) and repository permissions, then try again.",
    };
  }
  // Match real offline/unavailable phrasing only. A bare "daemon" substring
  // falsely classifies management-overlay and spawn failures (for example
  // `daemon_relay_v2_overlay_root_invalid`) as machine-offline.
  if (
    lower.includes("no machine") ||
    lower.includes("offline machine") ||
    lower.includes("machine daemon control connection is offline") ||
    lower.includes("machine daemon control connection is closed") ||
    lower.includes("machine daemon must enroll") ||
    lower.includes("machine daemon is not registered") ||
    lower.includes("desktop/daemon is online")
  ) {
    return {
      code: "machine_unavailable",
      summary: "The target machine was not available to start the agent.",
      action: "Make sure the xMatrix desktop/daemon is online on that machine, then try again.",
    };
  }
  // Strip command-line-looking tails for unknown errors so chat stays product-facing.
  const compact = detail
    .replace(/\bgit\s+fetch\b[^\n]*/giu, "repository refresh")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 280);
  return {
    code: "startup_failed",
    summary: compact || "The agent process could not start.",
    action: "Try again. If it keeps failing, check the machine's daemon logs for details.",
  };
}

/**
 * Classify a daemon stop error into a stable channel-safe code. The raw error
 * can carry host paths, command lines, or usernames and therefore never enters
 * channel-visible fields; complete diagnostics stay in the daemon's local
 * audit log.
 */
export function machineStopFailureCode(detail: string): string {
  const text = detail.toLowerCase();
  if (!text.trim()) return "unspecified";
  if (text.includes("still alive")) return "process_tree_still_alive";
  if (text.includes("permission") || text.includes("eperm") || text.includes("access is denied")) {
    return "permission_denied";
  }
  if (text.includes("timed out") || text.includes("timeout")) return "stop_timeout";
  return "stop_failed";
}

export function machineRunStartupFailureDetail(
  eventType: string | undefined,
  payload: Record<string, unknown>,
): { detail: string; phase?: string } | undefined {
  if (eventType === "machine_spawn_result" && payload.ok !== true) {
    return {
      detail: boundedMachineRunFailureText(payload.error)
        ?? "the Workstation could not launch the agent process",
    };
  }
  if (eventType !== "machine_run_exited") return undefined;
  const phase = boundedMachineRunFailureText(payload.statusPhase);
  if (!phase || !MACHINE_RUN_STARTUP_FAILURE_PHASES.has(phase)) return undefined;
  return {
    detail: boundedMachineRunFailureText(payload.runStatusDetail)
      ?? boundedMachineRunFailureText(payload.status)
      ?? `the agent process exited during ${phase}`,
    phase,
  };
}

export function machineSpawnRepoPoolMetadata(payload: Record<string, unknown>): Record<string, string> | undefined {
  if (payload.metadata === undefined) return undefined;
  if (!payload.metadata || typeof payload.metadata !== "object" || Array.isArray(payload.metadata)) {
    throw new TypeError("Machine Daemon spawn metadata must be an object");
  }
  const repoPool = (payload.metadata as Record<string, unknown>).repoPool;
  if (repoPool === undefined) return undefined;
  if (!repoPool || typeof repoPool !== "object" || Array.isArray(repoPool)) {
    throw new TypeError("Machine Daemon repo pool metadata must be an object");
  }
  const value = repoPool as Record<string, unknown>;
  const allowed = new Set(["repoIdentity", "repoKeyId", "slotId"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("Machine Daemon repo pool metadata contains an unreviewed field");
  }
  const repoIdentity = typeof value.repoIdentity === "string" ? value.repoIdentity.trim() : "";
  const repoKeyId = typeof value.repoKeyId === "string" ? value.repoKeyId : "";
  const slotId = typeof value.slotId === "string" ? value.slotId : "";
  if (!repoIdentity || repoIdentity.length > 1_000 || Array.from(repoIdentity).some(isControlCharacter) ||
      !/^[0-9a-f]{64}$/u.test(repoKeyId) ||
      !/^[0-9a-f]{32}$/u.test(slotId)) {
    throw new TypeError("Machine Daemon repo pool metadata is invalid");
  }
  return { repoIdentity, repoKeyId, slotId };
}
