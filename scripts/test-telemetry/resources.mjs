import { readdirSync, readFileSync } from "node:fs";
import process from "node:process";

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function linuxProcessRows(procRoot) {
  const rows = [];
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const stat = readFileSync(`${procRoot}/${entry.name}/stat`, "utf8");
      const afterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
      const parentPid = Number(afterName[1]);
      if (Number.isSafeInteger(parentPid)) rows.push({ pid, parentPid });
    } catch {
      // Processes may exit while /proc is being sampled.
    }
  }
  return rows;
}

function linuxDescendants(procRoot, rootPid) {
  const children = new Map();
  for (const row of linuxProcessRows(procRoot)) {
    const current = children.get(row.parentPid) ?? [];
    current.push(row.pid);
    children.set(row.parentPid, current);
  }
  const result = [];
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return result;
}

function linuxRssBytes(procRoot, pid) {
  try {
    const status = readFileSync(`${procRoot}/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function linuxFdCount(procRoot, pid) {
  try {
    return readdirSync(`${procRoot}/${pid}/fd`).length;
  } catch {
    return 0;
  }
}

export function sampleLinuxProcessTree(rootPid, procRoot = "/proc") {
  const pids = linuxDescendants(procRoot, rootPid);
  return {
    scope: "process_tree",
    rssBytes: pids.reduce((total, pid) => total + linuxRssBytes(procRoot, pid), 0),
    fdCount: pids.reduce((total, pid) => total + linuxFdCount(procRoot, pid), 0),
    processCount: pids.length,
  };
}

function selfFdCount() {
  for (const directory of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return readdirSync(directory).length;
    } catch {
      // Try the next platform-specific directory.
    }
  }
  return null;
}

export function sampleCurrentProcess() {
  const fdCount = selfFdCount();
  return {
    scope: "node_test_worker",
    rssBytes: process.memoryUsage.rss(),
    fdCount,
    processCount: 1,
  };
}

export function sampleTestProcessResources({ platform = process.platform, pid = process.pid, procRoot = "/proc" } = {}) {
  if (platform === "linux") {
    try {
      const sample = sampleLinuxProcessTree(pid, procRoot);
      if (sample.rssBytes > 0) return sample;
    } catch {
      // Minimal containers may not mount /proc. Self metrics still remain useful.
    }
  }
  return sampleCurrentProcess();
}

export function mergeResourcePeak(peak, sample) {
  return {
    scope: peak?.scope === "process_tree" || sample.scope === "process_tree" ? "process_tree" : "node_test_worker",
    rssBytes: Math.max(nonnegativeInteger(peak?.rssBytes) ?? 0, nonnegativeInteger(sample.rssBytes) ?? 0),
    fdCount: sample.fdCount === null && peak?.fdCount === null
      ? null
      : Math.max(nonnegativeInteger(peak?.fdCount) ?? 0, nonnegativeInteger(sample.fdCount) ?? 0),
    processCount: Math.max(nonnegativeInteger(peak?.processCount) ?? 0, nonnegativeInteger(sample.processCount) ?? 0),
  };
}
