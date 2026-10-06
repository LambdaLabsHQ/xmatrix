import type { DesktopCliInstallResult } from "@xmatrix/protocol";
export type { DesktopCliInstallResult } from "@xmatrix/protocol";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

/** The signed same-version CLI the release workflow packages under Resources/cli. */
export function desktopCliSeedPath(options: {
  resourcesPath: string;
  platform?: NodeJS.Platform | string;
}): string {
  const platform = options.platform || process.platform;
  return path.join(options.resourcesPath, "cli", platform === "win32" ? "xmatrix.exe" : "xmatrix");
}

/**
 * The seed installs itself and registers the daemon; the App only launches it.
 * Service definitions live in the binary (`xmatrix setup daemon`) on every
 * platform, including the Windows login Scheduled Task.
 */
export function cliSeedInstallArgs(seedPath: string, platform: NodeJS.Platform | string): string[] {
  void platform;
  return ["setup", "install", "--from", seedPath, "--daemon", "--json"];
}

export function installCliFromSeed(options: {
  seedPath: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  exists?: (candidate: string) => boolean;
  execFileImpl?: ExecFileLike;
}): Promise<DesktopCliInstallResult> {
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  if (!exists(options.seedPath)) {
    return Promise.resolve({
      ok: false,
      reason: "no-seed",
      message: `This build of xMatrix does not include a CLI seed (${options.seedPath}).`,
    });
  }
  const run = options.execFileImpl ?? (execFile as unknown as ExecFileLike);
  const platform = options.platform || process.platform;
  return new Promise((resolve) => {
    run(
      options.seedPath,
      cliSeedInstallArgs(options.seedPath, platform),
      { timeout: 120_000, env: options.env, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            reason: "install-failed",
            message: (stderr || error.message || "").trim() || "xMatrix CLI install failed.",
          });
          return;
        }
        resolve(parseInstallReport(stdout));
      },
    );
  });
}

function parseInstallReport(stdout: string): DesktopCliInstallResult {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const report = JSON.parse(line) as Record<string, unknown>;
      if (typeof report.installedPath === "string" && typeof report.version === "string") {
        const daemon = report.daemon && typeof report.daemon === "object"
          ? report.daemon as { manager?: unknown; definitionPath?: unknown }
          : null;
        return {
          ok: true,
          installedPath: report.installedPath,
          version: report.version,
          daemon: daemon && typeof daemon.manager === "string" && typeof daemon.definitionPath === "string"
            ? { manager: daemon.manager, definitionPath: daemon.definitionPath }
            : null,
        };
      }
    } catch {
      // Not the report line; keep looking.
    }
  }
  return {
    ok: false,
    reason: "install-failed",
    message: "The xMatrix CLI seed did not report an install result.",
  };
}
