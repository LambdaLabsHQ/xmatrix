import { spawn } from "node:child_process";

import { createProcessTreeLifecycle } from "./process-tree.mjs";

export class ProgressStageError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ProgressStageError";
    this.details = details;
  }
}

export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function formatCommand(command, args = []) {
  const quote = (value) =>
    /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value);
  return [command, ...args].map((value) => quote(String(value))).join(" ");
}

function runChild(stage, options) {
  const {
    now,
    output,
    errorOutput,
    prefix,
    position,
    total,
    spawnImpl,
    lifecycle,
    totalStartedAt,
  } = options;
  const stageStartedAt = now();
  const command = formatCommand(stage.command, stage.args);
  output(`[${prefix} ${position}/${total}] ${stage.label}`);

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      const stageElapsed = now() - stageStartedAt;
      if (!error) {
        output(
          `[${prefix} ${position}/${total}] OK ${stage.label} (${formatElapsed(stageElapsed)})`,
        );
        resolve();
        return;
      }
      const totalElapsed = now() - totalStartedAt;
      const summary =
        `[${prefix} ${position}/${total}] FAILED ${stage.label}; ` +
        `command=${command}; ${error}; stage=${formatElapsed(stageElapsed)}; ` +
        `total=${formatElapsed(totalElapsed)}`;
      errorOutput(summary);
      reject(
        new ProgressStageError(summary, {
          stage: stage.label,
          command,
          position,
          total,
          stageElapsed,
          totalElapsed,
        }),
      );
    };

    try {
      child = spawnImpl(stage.command, stage.args, {
        cwd: stage.cwd,
        env: stage.env,
        stdio: "inherit",
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      finish(`could not start: ${error.message}`);
      return;
    }

    lifecycle.track(child);
    child.once("error", (error) => finish(`could not start: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (signal || code !== 0) {
        // Reap descendants before the failed root's native process identity is
        // released. Waiting for `close` can be too late on Windows.
        lifecycle.cleanup();
      }
    });
    child.once("close", (code, signal) => {
      lifecycle.untrack(child);
      if (signal) finish(`signal=${signal}`);
      else if (code !== 0) finish(`exit code=${code ?? "unknown"}`);
      else finish();
    });
  });
}

async function runParallelGroup(stages, options) {
  const lanes = new Map();
  for (const entry of stages) {
    const lane = entry.stage.parallelLane || entry.stage.label;
    const laneStages = lanes.get(lane) || [];
    laneStages.push(entry);
    lanes.set(lane, laneStages);
  }

  let firstError = null;
  const results = await Promise.allSettled(
    [...lanes.values()].map(async (laneStages) => {
      for (const entry of laneStages) {
        if (firstError) return;
        try {
          await runChild(entry.stage, {
            ...options,
            position: entry.position,
          });
        } catch (error) {
          if (!firstError) {
            firstError = error;
            // A failed lane must stop every concurrently active process tree,
            // including descendants created by sibling lanes.
            options.lifecycle.cleanup();
          }
          throw error;
        }
      }
    }),
  );
  if (firstError) throw firstError;
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
}

export async function runProgressStages(stages, options = {}) {
  const prefix = options.prefix || "ci";
  const now = options.now || Date.now;
  const output = options.output || console.log;
  const errorOutput = options.errorOutput || console.error;
  const spawnImpl = options.spawnImpl || spawn;
  const lifecycle =
    options.lifecycle ||
    createProcessTreeLifecycle({
      ownerPid: options.ownerPid,
      ownerPids: options.ownerPids,
      pollIntervalMs: options.ownerPollIntervalMs,
    });
  const totalStartedAt = now();
  lifecycle.start();
  try {
    for (let index = 0; index < stages.length; ) {
      const parallelGroup = stages[index].parallelGroup;
      if (parallelGroup) {
        let end = index + 1;
        while (
          end < stages.length &&
          stages[end].parallelGroup === parallelGroup
        ) {
          end += 1;
        }
        await runParallelGroup(
          stages.slice(index, end).map((stage, offset) => ({
            stage,
            position: index + offset + 1,
          })),
          {
            now,
            output,
            errorOutput,
            prefix,
            total: stages.length,
            spawnImpl,
            lifecycle,
            totalStartedAt,
          },
        );
        index = end;
        continue;
      }
      await runChild(stages[index], {
        now,
        output,
        errorOutput,
        prefix,
        position: index + 1,
        total: stages.length,
        spawnImpl,
        lifecycle,
        totalStartedAt,
      });
      index += 1;
    }
  } finally {
    lifecycle.cleanup();
    lifecycle.dispose();
  }
  output(
    `[${prefix}] PASSED ${stages.length} stage${stages.length === 1 ? "" : "s"} ` +
      `in ${formatElapsed(now() - totalStartedAt)}`,
  );
}
