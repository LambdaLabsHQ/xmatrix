export type ExistingDaemonProcess = {
  pid: number;
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
): ExistingDaemonProcess[] {
  return stdout
    .split(/\r?\n/)
    .map((line): ExistingDaemonProcess | null => {
      const match = line.trimStart().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;

      const pid = Number.parseInt(match[1], 10);
      const command = match[2] || "";
      if (!Number.isFinite(pid) || pid === currentPid) return null;
      if (!commandLooksLikeXmatrixDaemon(command)) return null;

      return { pid, command, source: "process-scan" as const };
    })
    .filter((item): item is ExistingDaemonProcess => Boolean(item))
    .sort((left, right) => left.pid - right.pid);
}
