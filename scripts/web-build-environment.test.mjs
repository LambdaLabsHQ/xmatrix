import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { runBrowserBuild } from "../apps/web/e2e/build.mjs";
import { WEB_E2E_FIXTURE_ENV } from "../apps/web/e2e/fixture-env.mjs";

test("browser build fixtures reach only the Next child, not its parent or sibling", () => {
  const parent = { ...process.env };
  for (const key of Object.keys(WEB_E2E_FIXTURE_ENV)) delete parent[key];
  delete parent.NEXT_TEST_WASM;
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
      assert.equal(child.NEXT_TEST_WASM, "1");
      assert.equal(child.XMATRIX_ENV_TEST_SENTINEL, "preserved");
      return { status: 0 };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(parent, before);
  const sibling = readEnv(parent);
  for (const key of Object.keys(WEB_E2E_FIXTURE_ENV)) assert.equal(sibling[key], undefined);
  assert.equal(sibling.NEXT_TEST_WASM, undefined);
});

test("a failed or interrupted Next build cannot become a passing gate", () => {
  for (const [result, expected] of [[{ status: 2 }, 2], [{ status: null, signal: "SIGTERM" }, 1]]) {
    assert.equal(runBrowserBuild({ run: () => result }), expected);
  }
  assert.throws(() => runBrowserBuild({
    run: () => ({ error: new Error("could not start") }),
  }), /could not start/);
});
