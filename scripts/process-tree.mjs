import os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function processExists(pid, killImpl = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseProcessRows(stdout, fieldCount) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (values) =>
        values.length === fieldCount && values.every(Number.isSafeInteger),
    );
}

function unixProcessRecords(spawnSyncImpl) {
  const result = spawnSyncImpl(
    "ps",
    ["-e", "-o", "pid=", "-o", "ppid=", "-o", "pgid="],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) return [];
  return parseProcessRows(result.stdout, 3)
    .map(([pid, parentPid, processGroup]) => ({
      pid,
      parentPid,
      processGroup,
    }));
}

function windowsProcessRecords(spawnSyncImpl) {
  const script = [
    "Get-CimInstance Win32_Process |",
    "ForEach-Object { [Console]::Out.WriteLine(('{0} {1}' -f $_.ProcessId, $_.ParentProcessId)) }",
  ].join(" ");
  const result = spawnSyncImpl(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  if (result.status !== 0) return [];
  return parseProcessRows(result.stdout, 2).map(([pid, parentPid]) => ({
    pid,
    parentPid,
  }));
}

export function processAncestorPids(
  ownerPid,
  { platform = process.platform, spawnSyncImpl = spawnSync } = {},
) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1) return [];
  const records =
    platform === "win32"
      ? windowsProcessRecords(spawnSyncImpl)
      : unixProcessRecords(spawnSyncImpl);
  const byPid = new Map(records.map((record) => [record.pid, record]));
  const ancestors = [];
  const seen = new Set();
  let current = ownerPid;
  while (current > 1 && !seen.has(current)) {
    const record = byPid.get(current);
    if (!record) break;
    ancestors.push(current);
    seen.add(current);
    current = record.parentPid;
  }
  return ancestors.length > 0 ? ancestors : [ownerPid];
}

function unixProcessTree(rootPid, records) {
  const children = new Map();
  const byPid = new Map(records.map((record) => [record.pid, record]));
  for (const record of records) {
    const values = children.get(record.parentPid) || [];
    values.push(record.pid);
    children.set(record.parentPid, values);
  }
  const queue = [rootPid];
  const targetPids = new Set([rootPid]);
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of children.get(parent) || []) {
      if (targetPids.has(child)) continue;
      targetPids.add(child);
      queue.push(child);
    }
  }
  for (const record of records) {
    if (record.processGroup === rootPid) targetPids.add(record.pid);
  }
  return [...targetPids].map((pid) => byPid.get(pid)).filter(Boolean);
}

function killIgnoringMissing(killImpl, target, signal) {
  try {
    killImpl(target, signal);
    return true;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

export function terminateProcessTreeSync(
  rootPid,
  {
    platform = process.platform,
    killImpl = process.kill,
    spawnSyncImpl = spawnSync,
  } = {},
) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return false;
  if (platform === "win32") {
    const result = spawnSyncImpl(
      "taskkill.exe",
      ["/PID", String(rootPid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    return result.status === 0 || !processExists(rootPid, killImpl);
  }

  const records = unixProcessRecords(spawnSyncImpl);
  const targets = unixProcessTree(rootPid, records);
  const ownRecord = records.find((record) => record.pid === process.pid);
  const groups = new Set(
    targets
      .map((target) => target.processGroup)
      .filter((group) => group > 0 && group !== ownRecord?.processGroup),
  );
  if (targets.length > 0) groups.add(rootPid);

  let success = true;
  for (const group of groups) {
    if (group === ownRecord?.processGroup) continue;
    success = killIgnoringMissing(killImpl, -group, "SIGKILL") && success;
  }
  targets.sort((left, right) => right.pid - left.pid);
  for (const target of targets) {
    if (target.pid === process.pid) continue;
    success = killIgnoringMissing(killImpl, target.pid, "SIGKILL") && success;
  }
  return success;
}

export function createProcessTreeLifecycle({
  processObject = process,
  ownerPid = process.ppid,
  ownerPids,
  pollIntervalMs = 250,
  processExistsImpl = processExists,
  processAncestorPidsImpl = processAncestorPids,
  terminateProcessTreeImpl = terminateProcessTreeSync,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  exitImpl = (code) => processObject.exit(code),
} = {}) {
  const activeChildren = new Set();
  let ownerTimer = null;
  let started = false;
  let shuttingDown = false;
  const monitoredOwnerPids = ownerPids ?? processAncestorPidsImpl(ownerPid);

  const cleanup = () => {
    for (const child of Array.from(activeChildren)) {
      const pid = child?.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      terminateProcessTreeImpl(pid);
    }
  };
  const signalHandlers = new Map();
  const dispose = () => {
    if (!started) return;
    started = false;
    for (const [signal, handler] of signalHandlers) {
      processObject.removeListener(signal, handler);
    }
    signalHandlers.clear();
    processObject.removeListener("exit", cleanup);
    if (ownerTimer) clearIntervalImpl(ownerTimer);
    ownerTimer = null;
  };
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanup();
    dispose();
    exitImpl(code);
  };

  return {
    start() {
      if (started) return;
      started = true;
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        const handler = () => {
          const signalNumber = os.constants.signals[signal] || 1;
          shutdown(128 + signalNumber);
        };
        signalHandlers.set(signal, handler);
        processObject.once(signal, handler);
      }
      processObject.once("exit", cleanup);
      if (monitoredOwnerPids.length > 0) {
        ownerTimer = setIntervalImpl(() => {
          if (monitoredOwnerPids.some((pid) => !processExistsImpl(pid))) shutdown(1);
        }, pollIntervalMs);
        ownerTimer?.unref?.();
      }
    },
    track(child) {
      activeChildren.add(child);
    },
    untrack(child) {
      activeChildren.delete(child);
    },
    cleanup,
    dispose,
  };
}
