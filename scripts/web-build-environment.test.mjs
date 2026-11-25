import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";

import { runBrowserBuild } from "../apps/web/e2e/build.mjs";
import { WEB_E2E_FIXTURE_ENV } from "../apps/web/e2e/fixture-env.mjs";
import { readRepoFile } from "./script-test-fixture.mjs";

test("browser build fixtures reach only the Next child, not its parent or sibling", () => {
  const parent = { ...process.env };
  for (const key of Object.keys(WEB_E2E_FIXTURE_ENV)) delete parent[key];
  parent.NEXT_TEST_WASM = "1";
  parent.XMATRIX_ENV_TEST_SENTINEL = "preserved";
  const before = { ...parent };
  const readEnv = (env) => {
    const child = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], {
      env, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const code = runBrowserBuild({
    env: parent,
    run: (command, args, options) => {
      assert.equal(command, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
      assert.deepEqual(args, ["exec", "next", "build"]);
      const child = readEnv(options.env);
      for (const [key, value] of Object.entries(WEB_E2E_FIXTURE_ENV)) {
        assert.equal(child[key], value);
      }
      assert.equal(child.NEXT_TEST_WASM, undefined);
      assert.equal(child.XMATRIX_ENV_TEST_SENTINEL, "preserved");
      return { status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(parent, before);
  const sibling = readEnv(parent);
  for (const key of Object.keys(WEB_E2E_FIXTURE_ENV)) assert.equal(sibling[key], undefined);
  assert.equal(sibling.NEXT_TEST_WASM, "1");
});

test("a failed or interrupted Next build cannot become a passing gate", () => {
  for (const [result, expected] of [[{ status: 2 }, 2], [{ status: null, signal: "SIGTERM" }, 1]]) {
    assert.equal(runBrowserBuild({ run: () => result }), expected);
  }
  assert.throws(() => runBrowserBuild({
    run: () => ({ error: new Error("could not start") }),
  }), /could not start/);
});

test("production Web and Android builds use native SWC and a single authoritative Next typecheck", () => {
  const server = parse(readRepoFile(".github/workflows/server-release.yml"));
  const buildStep = server.jobs.build.steps.find((step) => step.name === "Typecheck and build production Web");
  assert.ok(buildStep, "server-release.yml keeps the production Web build step");
  assert.equal(buildStep.env?.NEXT_TEST_WASM, undefined, "production Web must compile with native SWC");
  assert.equal(
    buildStep.env?.XMATRIX_NEXT_BUILD_SKIP_CHECKS,
    undefined,
    "production Web must keep Next.js lint and typecheck active",
  );
  assert.equal(buildStep.run.trim(), "pnpm --filter @xmatrix/web build:cloudflare");

  const android = parse(readRepoFile(".github/workflows/android-deploy.yml"));
  const androidBuild = android.jobs.build.steps.find((step) => step.name === "Build and deploy Android");
  assert.ok(androidBuild, "android-deploy.yml keeps the Android build step");
  assert.equal(androidBuild.env?.NEXT_TEST_WASM, undefined, "Android Web bundle must compile with native SWC");
});
