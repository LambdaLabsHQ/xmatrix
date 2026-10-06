import fs from "node:fs";
import process from "node:process";

import {
  sharedBrowserEnabled,
  sharedBrowserPidPath,
  sharedBrowserWsPath,
} from "./shared-browser-paths";

export default async function globalTeardown() {
  if (!sharedBrowserEnabled()) return;

  const cwd = process.cwd();
  const pidPath = sharedBrowserPidPath(cwd);
  const wsPath = sharedBrowserWsPath(cwd);

  let pid: number | undefined;
  try {
    const raw = fs.readFileSync(pidPath, "utf8").trim();
    pid = Number(raw);
  } catch {
    pid = undefined;
  }

  if (Number.isSafeInteger(pid) && (pid as number) > 0) {
    try {
      process.kill(pid as number, "SIGTERM");
    } catch {
      // Already exited.
    }
  }

  for (const file of [wsPath, pidPath]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}
