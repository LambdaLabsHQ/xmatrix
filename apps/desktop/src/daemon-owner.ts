export type ExistingDaemonProcess = {
  /** Unknown when only the daemon's held lock says it runs (Windows). */
  pid?: number;
  command: string;
  source: "lock" | "process-scan";
};

export function parseDaemonLockPid(contents: string): number | null {
  const match = contents.match(/(?:^|\n)\s*pid=(\d+)\s*(?:\n|$)/);
  if (!match) return null;

  const pid = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function firstCommandToken(command: string) {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 1) {
      return trimmed.slice(1, end);
    }
  }
  return trimmed.split(/\s+/)[0]?.replace(/^"|"$/g, "") || "";
}

function executableBasename(command: string) {
  const executable = firstCommandToken(command);
  return executable.split(/[\\/]/).pop() || executable;
}

export function commandLooksLikeXmatrixDaemon(command: string) {
  const executable = executableBasename(command).replace(/\.exe$/i, "");
  if (executable !== "xmatrix" && executable !== "xmatrix-real") {
    return false;
  }

  return command.trim().split(/\s+/).slice(1).includes("daemon");
}

export function parsePsDaemonProcesses(
  stdout: string,
  currentPid: number
): (ExistingDaemonProcess & { pid: number })[] {
  return stdout
    .split(/\r?\n/)
    .map((line): (ExistingDaemonProcess & { pid: number }) | null => {
      const match = line.trimStart().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;

      const pid = Number.parseInt(match[1], 10);
      const command = match[2] || "";
      if (!Number.isFinite(pid) || pid === currentPid) return null;
      if (!commandLooksLikeXmatrixDaemon(command)) return null;

      return { pid, command, source: "process-scan" as const };
    })
    .filter((item): item is ExistingDaemonProcess & { pid: number } => Boolean(item))
    .sort((left, right) => left.pid - right.pid);
}

/**
 * Whether a running daemon holds `daemon.lock`. The daemon takes it
 * exclusively for its whole life; on Windows that lock also refuses other
 * processes' reads (ERROR_LOCK_VIOLATION, which Node reports as EBUSY), so a
 * refused read is the daemon itself saying it runs. Elsewhere the lock is
 * advisory and the file reads normally, so this says nothing there.
 */
export function daemonLockReadRefused(read: () => unknown): boolean {
  try {
    read();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EBUSY";
  }
}
