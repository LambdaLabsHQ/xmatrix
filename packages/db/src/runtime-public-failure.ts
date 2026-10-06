import { publicMachineStartupFailure } from "@xmatrix/protocol";

/** Public diagnostics are stable classifications, never redacted stderr/SQL text. */
export function publicRuntimeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_.-]{0,79}$/u.test(value) ? value : undefined;
}

export function publicLaunchFailureCode(code: unknown, detail: unknown): string | undefined {
  return (code === "daemon_spawn_failed" || code === "machine_spawn_failed"
    ? publicMachineStartupFailure(detail)?.code : undefined) ?? publicRuntimeErrorCode(code);
}

const LAUNCH_FAILURE_MESSAGES: Record<string, string> = {
  machine_command_missing: "The startup command is unavailable. Refresh the invocation before requesting another start.",
  daemon_spawn_failed: "The machine could not start the agent process. Inspect the recorded startup steps and machine diagnostics.",
  machine_spawn_failed: "The machine could not start the agent process. Inspect the recorded startup steps and machine diagnostics.",
  directory_publish_unavailable: "Startup routing could not be confirmed. The launch may already exist; refresh its status before retrying.",
  postgres_runtime_unavailable: "The startup service is temporarily unavailable. Refresh status before retrying.",
  runtime_transaction_retry_exhausted: "Startup could not acquire its required state after bounded retries. Refresh status before retrying.",
  runtime_sql_contract_error: "The startup service encountered an internal error. Use the diagnostic reference to investigate.",
  machine_offline: "The selected machine is offline. Reconnect it and check the original invocation.",
};

export function publicLaunchFailureMessage(code: unknown, detail?: unknown): string {
  const failure = code === "daemon_spawn_failed" || code === "machine_spawn_failed"
    ? publicMachineStartupFailure(detail) : undefined;
  if (failure) return `${failure.summary} ${failure.action}`;
  return typeof code === "string" && Object.hasOwn(LAUNCH_FAILURE_MESSAGES, code)
    ? LAUNCH_FAILURE_MESSAGES[code]!
    : "Startup failed. Inspect the recorded steps and diagnostic reference before retrying.";
}
