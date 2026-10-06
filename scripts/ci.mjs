#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runAdmittedCiStages } from "./ci-host-admission.mjs";
import { androidToolchainEnv } from "./ci-android-toolchain.mjs";
import { partitionNames } from "./ci-areas.mjs";
import {
  nodeTestParallelGroup,
  nodeTestStages,
} from "./ci-node-tests.mjs";
import {
  playwrightPortIsFree,
  preferredPlaywrightPort,
} from "./ci-playwright-port.mjs";
import { leasePort } from "./ci-port-lease.mjs";
import { ProgressStageError } from "./ci-progress.mjs";
import { discoverScriptTests } from "./ci-script-tests.mjs";
import { rustCompileCacheEnv } from "./kache-env.mjs";
import { playwrightLinuxLibraryPath } from "./playwright-linux-deps.mjs";
import { rustTestThreadCount } from "./rust-test-threads.mjs";
import { turboCacheArgs } from "./turbo-cache.mjs";
import { WEB_E2E_FIXTURE_ENV } from "../apps/web/e2e/fixture-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2);
const selected = requested.length > 0 ? requested : partitionNames;
const pnpm = "pnpm";
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const commandProcessor = process.env.ComSpec || "cmd.exe";
const androidGradle = path.join(
  rootDir,
  "apps",
  "android",
  process.platform === "win32" ? "gradlew.bat" : "gradlew",
);
const rustCache = rustCompileCacheEnv(process.env);
const rustTestThreads = rustTestThreadCount();
const linuxCi = process.platform === "linux" && Boolean(process.env.CI);
const playwrightLinuxDepsDir = path.join(
  os.homedir(),
  ".cache",
  "xmatrix",
  "playwright-linux-deps",
);
const playwrightInstallArgs = [
  "--filter",
  "@xmatrix/web",
  "exec",
  "playwright",
  "install",
  "chromium",
];
const playwrightRuntimeEnv = linuxCi
  ? {
      LD_LIBRARY_PATH: playwrightLinuxLibraryPath(
        playwrightLinuxDepsDir,
        process.env.LD_LIBRARY_PATH,
      ),
    }
  : {};
// Same fixture env as Playwright webServer (apps/web/e2e/fixture-env.mjs).
const playwrightFixtureEnv = WEB_E2E_FIXTURE_ENV;
// Local partition runs can run concurrently in several worktrees, so they get
// a process-scoped port; CI keeps a fixed one for readable logs. Neither
// is trusted blindly: our runners are self-hosted and share a host, and a
// cancelled run can leave its server holding the port, so the preference only
// stands while nothing is listening on it.
// Use GITHUB_ACTIONS (not CI): a local CI-equivalent browser run may set CI=1
// for Playwright behavior, which would otherwise force every worktree onto
// 24611.
// The port is leased, not merely probed: `next start` binds it minutes later,
// after install and build, and a probe says nothing about that window. The
// lease is held until this process exits so a neighbouring worktree can never
// pick the same port and lose the race at bind time.
const playwrightPortLease = await leasePort({
  preferred: preferredPlaywrightPort(),
  isFree: playwrightPortIsFree,
});
const playwrightPortBase = playwrightPortLease.port;
process.on("exit", playwrightPortLease.release);
const scriptTests = discoverScriptTests(rootDir);

function turboArgs(tasks, filter) {
  const args = [
    "exec",
    "turbo",
    "run",
    ...tasks,
    `--filter=${filter}`,
    "--output-logs=new-only",
  ];
  return [...args, ...turboCacheArgs()];
}

const hubWorkspaceBuild = {
  label: "Build Hub workspace dependencies",
  command: pnpm,
  args: turboArgs(["build"], "@xmatrix/hub^..."),
};
const hubRenderConfig = {
  label: "Render the CI Hub deployment config",
  command: process.execPath,
  args: ["scripts/deploy-config.mjs", "render", "ci", "hub"],
};
const hubTypecheck = {
  label: "Typecheck hub",
  command: pnpm,
  args: ["--filter", "@xmatrix/hub", "typecheck:ci"],
  parallelGroup: "hub-checks",
  parallelLane: "typecheck",
};
const hubBundle = {
  label: "Bundle hub for deploy",
  command: pnpm,
  args: ["--dir", "packages/hub", "exec", "wrangler", "deploy", "--dry-run", "--config", "wrangler.generated.ci.toml"],
  parallelGroup: "hub-checks",
  parallelLane: "bundle",
};
const hubTest = {
  label: "Test hub",
  command: pnpm,
  args: ["--filter", "@xmatrix/hub", "test:ci"],
  parallelGroup: "hub-checks",
  parallelLane: "test",
};

const rustCliTest = {
  label: "Test Rust CLI",
  command: cargo,
  args: ["test"],
  cwd: path.join(rootDir, "packages/cli-rs"),
  // Explicit kache wrapper with conservative Windows native-cache flags.
  // Still runs the full cargo test suite — no checks are skipped.
  // Workers come from this job's share of the machine
  // (scripts/rust-test-threads.mjs). Do not replace the full suite with
  // filtered or feature-specific variants.
  // A compiler crash is a required-gate failure and is never retried.
  env: { ...rustCache.env, RUST_TEST_THREADS: String(rustTestThreads) },
};

const rustClippy = {
  label: "Check Clippy (-D warnings)",
  command: cargo,
  args: ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
  cwd: path.join(rootDir, "packages/cli-rs"),
  env: rustCache.env,
};

// The production build remains part of the fast Web validation because it is
// the authoritative Web typecheck. The standalone browser partition also
// needs the same fixture-env build. When callers request both partitions in
// one process (as required CI does), stageId deduplication below executes it
// once and lets Playwright consume the resulting tree.
const webBuildStep = {
  stageId: "web-production-build",
  // Produce the fixture-env production tree once through Turbo so later
  // browser runs can restore .next from the runner-home cache instead of
  // paying a cold Webpack compile inside Playwright's webServer.
  //
  // This is also where `apps/web` is type-checked. `next.config.ts` sets no
  // `typescript.ignoreBuildErrors`, so the build type-checks the whole
  // project — including source no route imports — and fails on an error.
  // A separate `tsc --noEmit` step used to run before this one and was
  // strictly weaker: it ran before anything wrote `.next/types`, so on a
  // clean checkout it judged the app *without* generated route types,
  // while the build regenerates them first and judges with them.
  //
  // It was also the only step that could fail on artifacts alone. Because
  // `.next/` is gitignored, a reused local checkout keeps per-route type
  // files for routes that have since been deleted; `tsc` reads them via
  // the `.next/types/**/*.ts` include in `apps/web/tsconfig.json` and
  // reports missing modules for sources that are simply gone. The build
  // prunes those files, but it never got the chance — the earlier step had
  // already failed. Do not reintroduce a standalone web typecheck.
  //
  // The Next.js build cache (apps/web/.next/cache) survives the clean
  // checkout through scripts/next-build-cache.mjs: a warm webpack compile of
  // a changed tree took 14s instead of 38s.
  // One Turbo graph builds protocol once, then runs the independent unit tests
  // and Next build concurrently. test:ci skips the standalone pretest build;
  // its ^build dependency still makes a fresh checkout safe. A browser-only
  // invocation keeps its existing build-only behavior.
  label: selected.includes("web") ? "Test and build web" : "Build web",
  command: process.execPath,
  args: ["scripts/next-build-cache.mjs", "--", pnpm, ...turboArgs(
    selected.includes("web") ? ["test:ci", "e2e:build"] : ["e2e:build"],
    "@xmatrix/web",
  )],
};

// XMATRIX_PLAYWRIGHT_SHARD=<n>/<count> lets hosted CI spread the browser run
// over parallel jobs. Playwright keeps a project's dependency chain in one
// shard, so `performance` (ordered after the functional projects only to keep
// host contention out of its wall-clock budget) would pull every functional
// case into one shard. Sharded jobs therefore split the functional projects,
// and the last one then runs `performance` alone on its own machine. Every
// shard together is the full browser run.
function browserTestStages() {
  const shard = process.env.XMATRIX_PLAYWRIGHT_SHARD;
  const stage = (label, extraArgs) => ({
    // webServer only starts the prebuilt tree, then the disjoint Web,
    // mock-app, and Relay V2 projects share that one production server.
    label,
    command: pnpm,
    args: ["--filter", "@xmatrix/web", "test:e2e:ci", ...extraArgs],
    env: {
      ...playwrightRuntimeEnv,
      ...playwrightFixtureEnv,
      CI: "1",
      NEXT_TEST_WASM: "1",
      PLAYWRIGHT_PORT: String(playwrightPortBase),
      PLAYWRIGHT_PREBUILT: "1",
    },
  });
  if (!shard) return [stage("Test browser projects", [])];
  const [index, count] = shard.split("/");
  return [
    stage(`Test functional browser projects (shard ${shard})`, [
      "--project=web",
      "--project=mock-app",
      `--shard=${shard}`,
    ]),
    ...(index === count
      ? [stage("Test the browser performance budget", ["--project=performance", "--no-deps"])]
      : []),
  ];
}

const partitions = {
  "node-checks": [
    {
      label: "Check Oxlint (--deny-warnings)",
      command: pnpm,
      args: ["exec", "oxlint", "--config", ".oxlintrc.json", "--deny-warnings", "."],
    },
    {
      label: "Build protocol and billing for executable evidence",
      command: pnpm,
      args: turboArgs(["build"], "@xmatrix/db^..."),
    },
    {
      label: "Check PostgreSQL package and migrations",
      command: pnpm,
      args: ["--filter", "@xmatrix/db", "check"],
    },
    {
      label: "Test protocol",
      command: pnpm,
      args: turboArgs(["test"], "@xmatrix/protocol"),
      parallelGroup: nodeTestParallelGroup,
      parallelLane: "protocol-test",
    },
    {
      label: "Test the default billing policy",
      command: pnpm,
      args: turboArgs(["test"], "@xmatrix/billing"),
      parallelGroup: nodeTestParallelGroup,
      parallelLane: "billing-test",
    },
    ...nodeTestStages({ allFiles: scriptTests }),
    {
      label: "Check synchronized versions",
      command: process.execPath,
      args: ["scripts/version.mjs", "check"],
      parallelGroup: nodeTestParallelGroup,
      parallelLane: "version-check",
    },
    {
      label: "Check dependency reachability",
      command: pnpm,
      args: ["run", "check:reachability"],
      env: { KNIP_OXC_RAW_TRANSFER: "0" },
      parallelGroup: nodeTestParallelGroup,
      parallelLane: "reachability-check",
    },
    {
      label: "Check unused imports",
      command: pnpm,
      args: ["run", "check:unused-imports"],
      parallelGroup: nodeTestParallelGroup,
      parallelLane: "unused-imports-check",
    },
    {
      label: "Check duplicate CSS rules",
      command: pnpm,
      args: ["run", "check:css-duplicate-rules"],
      parallelGroup: nodeTestParallelGroup,
      parallelLane: "css-duplicate-rules-check",
    },
    {
      label: "Check source line limit (≤5000)",
      command: pnpm,
      args: ["run", "check:line-limit"],
      parallelGroup: nodeTestParallelGroup,
      parallelLane: "line-limit-check",
    },
  ],
  web: [
    webBuildStep,
  ],
  "web-browser": [
    {
      label: "Install Playwright Chromium",
      command: pnpm,
      args: playwrightInstallArgs,
    },
    ...(linuxCi
      ? [
          {
            label: "Prepare Playwright Linux dependencies",
            command: process.execPath,
            args: ["scripts/playwright-linux-deps.mjs", playwrightLinuxDepsDir],
          },
        ]
      : []),
    // A hosted browser shard leaves lint and the type check to its run's
    // `web` job, which builds the same tree with both.
    process.env.XMATRIX_PLAYWRIGHT_SHARD && !selected.includes("web")
      ? { ...webBuildStep, env: { ...webBuildStep.env, XMATRIX_NEXT_BUILD_SKIP_CHECKS: "1" } }
      : webBuildStep,
    ...browserTestStages(),
  ],
  // Exact-SHA gate: build the Hub's workspace dependencies once, then typecheck,
  // the full suite and the production bundle in parallel. typecheck:ci / test:ci
  // intentionally skip package pretest hooks so protocol is not rebuilt. The
  // bundle lane is the deploy's wrangler dry-run, of the product config rendered
  // with the placeholder `ci` profile (no deployment's identity), so a bundling
  // break fails the PR instead of the production release.
  hub: [
    hubWorkspaceBuild,
    hubRenderConfig,
    hubTypecheck,
    hubTest,
    hubBundle,
  ],
  // Hosted CI splits the Hub gate over parallel jobs: one static job
  // (typecheck, deploy bundle and the workspace packages' PostgreSQL tests)
  // and XMATRIX_HUB_TEST_SHARD slices of the Hub test files. Together they run
  // exactly what the `hub` partition runs.
  "hub-static": [
    hubWorkspaceBuild,
    hubRenderConfig,
    hubTypecheck,
    {
      ...hubTest,
      label: "Test PostgreSQL workspace packages",
      env: { XMATRIX_HUB_SUITE_PART: "packages" },
    },
    hubBundle,
  ],
  "hub-files": [
    hubWorkspaceBuild,
    {
      ...hubTest,
      label: `Test hub files${process.env.XMATRIX_HUB_TEST_SHARD ? ` (shard ${process.env.XMATRIX_HUB_TEST_SHARD})` : ""}`,
      env: { XMATRIX_HUB_SUITE_PART: "files" },
      parallelGroup: undefined,
      parallelLane: undefined,
    },
  ],
  desktop: [
    {
      label: "Test and build desktop",
      command: pnpm,
      args: turboArgs(["test", "build"], "@xmatrix/desktop"),
    },
  ],
  android: [
    {
      label: "Test and lint Android",
      // Windows batch files require a command processor; Node cannot execute
      // them directly. The wrapper path and arguments are CI-owned constants.
      command: process.platform === "win32" ? commandProcessor : androidGradle,
      args:
        process.platform === "win32"
          ? [
              "/d",
              "/c",
              androidGradle,
              ":app:testDebugUnitTest",
              ":app:lintDebug",
              "--stacktrace",
            ]
          : [":app:testDebugUnitTest", ":app:lintDebug", "--stacktrace"],
      cwd: path.join(rootDir, "apps/android"),
      // Fills in JAVA_HOME and ANDROID_HOME only when nothing else has. A
      // developer Mac routinely has both installed and neither exported, and
      // Gradle then reports them missing one at a time. Runners export both,
      // so this contributes nothing there.
      env: androidToolchainEnv(),
    },
  ],
  "rust-cli": [rustClippy, rustCliTest],
  duplicates: [
    {
      label: "Check duplicated code",
      command: pnpm,
      args: ["run", "check:duplicates"],
      // Runs after, not beside, the Node check lanes when CI requests both:
      // on a 4-CPU hosted VM the scan starves their process-tree timing tests.
    },
  ],
  // The Windows required gate runs the same Cargo suite. Platform-independent
  // duplicate-source validation runs in its own parallel required partition.
  "rust-cli-windows": [rustCliTest],
};

function fail(message) {
  console.error(`[ci] ${message}`);
  process.exit(1);
}

function commandForPlatform(step) {
  if (process.platform !== "win32" || step.command !== pnpm) {
    return { command: step.command, args: step.args };
  }

  const quote = (value) =>
    /\s|["&<>|^]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", [step.command, ...step.args].map(quote).join(" ")],
  };
}

function runnableStep(partition, step) {
  const invocation = commandForPlatform(step);
  return {
    label: `${partition}: ${step.label}`,
    command: invocation.command,
    args: invocation.args,
    cwd: step.cwd ?? rootDir,
    env: { ...process.env, ...step.env },
    parallelGroup: step.parallelGroup,
    parallelLane: step.parallelLane,
  };
}

for (const partition of selected) {
  if (!Object.hasOwn(partitions, partition)) {
    fail(
      `Unknown partition '${partition}'. Expected one of: ${Object.keys(partitions).join(", ")}.`,
    );
  }
}

if (
  selected.some(
    (partition) => partition === "rust-cli" || partition === "rust-cli-windows",
  )
) {
  if (rustCache.enabled) {
    console.log(`[ci] kache enabled: ${rustCache.detail}`);
  } else {
    console.log(`[ci] ${rustCache.detail}`);
  }
}

const seenStageIds = new Set();
const partitionStages = selected.flatMap((partition) =>
  partitions[partition]
    .filter((step) => {
      if (!step.stageId) return true;
      if (seenStageIds.has(step.stageId)) return false;
      seenStageIds.add(step.stageId);
      return true;
    })
    .map((step) => runnableStep(partition, step)),
);
try {
  await runAdmittedCiStages(partitionStages);
} catch (error) {
  if (error instanceof ProgressStageError) process.exit(1);
  throw error;
}
