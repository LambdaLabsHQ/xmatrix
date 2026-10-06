import os from "node:os";
import process from "node:process";

const parallelGroup = "node-check-tests";
const pureContractFiles = Object.freeze([
  "scripts/ci-areas.test.mjs",
  "scripts/configure-release-storage.test.mjs",
  "scripts/desktop-release-signing.test.mjs",
  "scripts/kache-env.test.mjs",
  "scripts/playwright-linux-deps.test.mjs",
  "scripts/prune-r2-release-assets.test.mjs",
  "scripts/release-publication-policy.test.mjs",
  "scripts/release-version-order.test.mjs",
  "scripts/r2-release-store.test.mjs",
  "scripts/rust-test-threads.test.mjs",
]);

const childProcessFiles = Object.freeze([
  "scripts/ci-progress.test.mjs",
]);

export const nodeTestResourceFiles = Object.freeze({
  pureContract: pureContractFiles,
  childProcess: childProcessFiles,
});

export function resolvedNodeTestResourceFiles(allFiles) {
  if (allFiles === undefined) return nodeTestResourceFiles;
  const discovered = new Set(allFiles);
  const classified = new Set();
  for (const files of Object.values(nodeTestResourceFiles)) {
    for (const file of files) {
      if (!discovered.has(file)) throw new Error(`Classified Node test does not exist: ${file}`);
      if (classified.has(file)) throw new Error(`Node test is classified more than once: ${file}`);
      classified.add(file);
    }
  }
  // Newly added tests execute immediately in the bounded child-process lane.
  // Maintainers may later move a test to a more precise resource class, but a
  // missing classification can never make a tracked test silently disappear.
  const unclassified = [...discovered].filter((file) => !classified.has(file)).sort();
  return Object.freeze({
    ...nodeTestResourceFiles,
    childProcess: Object.freeze([...nodeTestResourceFiles.childProcess, ...unclassified]),
  });
}

export function nodeTestConcurrencies(available = os.availableParallelism?.() || os.cpus().length) {
  const parallelism = Number.isSafeInteger(available) && available > 0 ? available : 1;
  return {
    pureContract: parallelism,
    // These files create their own subprocesses. Four file workers keep the
    // aggregate process and descriptor count bounded while the pure lane uses
    // every available core independently.
    childProcess: Math.max(1, Math.min(4, Math.floor(parallelism / 2))),
  };
}

function testStage(label, files, lane, concurrency) {
  return {
    label,
    command: process.execPath,
    args: ["--test", `--test-concurrency=${concurrency}`, ...files],
    parallelGroup,
    parallelLane: lane,
  };
}

export function nodeTestStages(options = {}) {
  const concurrency = nodeTestConcurrencies(options.availableParallelism);
  const resourceFiles = resolvedNodeTestResourceFiles(options.allFiles);
  return [
    testStage("Test pure Node contracts", resourceFiles.pureContract, "pure-contract", concurrency.pureContract),
    testStage(
      "Test child-process Node contracts",
      resourceFiles.childProcess,
      "child-process",
      concurrency.childProcess
    ),
  ].filter((stage) => stage.args.some((arg) => arg.endsWith(".test.mjs") || arg.endsWith(".e2e.mjs")));
}

export const nodeTestParallelGroup = parallelGroup;
