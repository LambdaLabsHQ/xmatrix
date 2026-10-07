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

/** Harnesses on the connected machine this Space can take in now. */
export function harnessesToBringIn(status: SetupIntentStatus | undefined): Array<{ id: string; name: string }> {
  const registered = new Set(status?.registeredHarnesses ?? []);
  return (status?.machine?.harnesses ?? [])
    .filter((harness) => harness.installed && !registered.has(harness.id))
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
  | { kind: "none-installed"; machineName: string }
  | { kind: "done"; machineName: string };

/** A wait says more the longer it lasts, but never before it could have finished. */
const CHECK_TERMINAL_AFTER_MS = 45_000;
const TRY_DESKTOP_AFTER_MS = 3 * 60_000;

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
  const harnesses = harnessesToBringIn(status);
  if (harnesses.length > 0) return { kind: "found", machineName, harnesses };
  if (status.registeredHarnesses.length > 0) return { kind: "done", machineName };
  return { kind: "none-installed", machineName };
}

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Gemini". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
