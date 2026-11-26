import { AGENT_PRESETS, type SetupIntentStatus } from "@xmatrix/protocol";

/* Connecting a machine from the Web (docs/design/onboarding-connect-machine.md).
   The Hub derives every fact; this file only turns them into the one line the
   page shows next, and decides when a wait has gone on long enough to say
   what else to try. */

export type InstallPlatform = "unix" | "windows";

/** The one line a person pastes on the machine to connect it. */
export function setupInstallCommand(intentId: string, platform: InstallPlatform): string {
  return platform === "windows"
    ? `$env:XMATRIX_CONNECT='${intentId}'; irm https://xmatrix.sh/install.ps1 | iex`
    : `curl -fsSL https://xmatrix.sh/install.sh | bash -s -- --connect ${intentId}`;
}

export function defaultInstallPlatform(userAgent: string): InstallPlatform {
  return /windows/iu.test(userAgent) ? "windows" : "unix";
}

/** The platform a signed-in terminal reported (`windows-x86_64`, `macos-aarch64`), when it did. */
export function terminalInstallPlatform(platform: string | undefined): InstallPlatform | undefined {
  if (!platform) return undefined;
  return platform.startsWith("windows") ? "windows" : "unix";
}

/** Harnesses the connected machine reported as installed. */
export function installedHarnesses(status: SetupIntentStatus | undefined): Array<{ id: string; name: string }> {
  return (status?.machine?.harnesses ?? [])
    .filter((harness) => harness.installed)
    .flatMap((harness) => {
      const preset = AGENT_PRESETS.find((candidate) => candidate.id === harness.id);
      return preset ? [{ id: preset.id, name: preset.displayName }] : [];
    });
}

export type ConnectStep =
  | { kind: "waiting"; hint: "none" | "check-terminal" | "try-desktop" }
  | { kind: "approval"; hostname: string; userCode: string }
  | { kind: "connecting"; hostname: string }
  | { kind: "looking"; machineName: string }
  | { kind: "found"; machineName: string; harnesses: Array<{ id: string; name: string }> }
  | { kind: "none-installed"; machineName: string };

/** A wait says more the longer it lasts, but never before it could have finished. */
const CHECK_TERMINAL_AFTER_MS = 45_000;
const TRY_DESKTOP_AFTER_MS = 3 * 60_000;

const ACTIVE_POLL_MS = 2_000;
const SLOW_WAIT_POLL_MS = 5_000;
const IDLE_WAIT_POLL_MS = 15_000;
const SLOW_WAIT_AFTER_MS = 2 * 60_000;
const IDLE_WAIT_AFTER_MS = 10 * 60_000;

export interface SetupIntentNeed {
  another: boolean;
  phone: boolean;
  appFirst: boolean;
  platformReady: boolean;
  catalogSettled: boolean;
  daemonsSettled: boolean;
  hasEnabledAgents: boolean;
  hasInstalledCandidates: boolean;
}

/** Whether this setup card actually shows a terminal command and needs a live setup intent. */
export function setupIntentNeeded(input: SetupIntentNeed): boolean {
  if (input.phone) return false;
  if (input.another) return true;
  if (!input.platformReady || input.appFirst) return false;
  if (!input.catalogSettled || !input.daemonsSettled) return false;
  return !input.hasEnabledAgents && !input.hasInstalledCandidates;
}

/** Whether the connected machine already reported at least one installed harness. */
export function setupIntentReported(status: SetupIntentStatus | undefined): boolean {
  return status?.phase === "connected" && Boolean(status.machine?.harnesses?.some((harness) => harness.installed));
}

/** Adaptive poll cadence: snappy while a terminal is active or just shown, slower while idle, stopped once reported. */
export function setupIntentPollIntervalMs(status: SetupIntentStatus | undefined, elapsedMs: number): number | false {
  if (setupIntentReported(status)) return false;
  if (status && status.phase !== "waiting") return ACTIVE_POLL_MS;
  if (elapsedMs >= IDLE_WAIT_AFTER_MS) return IDLE_WAIT_POLL_MS;
  if (elapsedMs >= SLOW_WAIT_AFTER_MS) return SLOW_WAIT_POLL_MS;
  return ACTIVE_POLL_MS;
}

export function connectStep(status: SetupIntentStatus, waitingForMs: number): ConnectStep {
  const hostname = status.terminal?.hostname || "A terminal";
  if (status.phase === "waiting") {
    return {
      kind: "waiting",
      hint: waitingForMs >= TRY_DESKTOP_AFTER_MS ? "try-desktop"
        : waitingForMs >= CHECK_TERMINAL_AFTER_MS ? "check-terminal" : "none",
    };
  }
  if (status.phase === "approval" && status.terminal) {
    return { kind: "approval", hostname, userCode: status.terminal.userCode };
  }
  if (status.phase !== "connected" || !status.machine) return { kind: "connecting", hostname };
  const machineName = status.machine.name;
  if (!status.machine.harnesses) return { kind: "looking", machineName };
  const harnesses = installedHarnesses(status);
  return harnesses.length > 0 ? { kind: "found", machineName, harnesses } : { kind: "none-installed", machineName };
}

