import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KACHE_VERSION,
  defaultKacheCacheDir,
  resolveKacheBinary,
  rustCompileCacheEnv,
} from "./kache-env.mjs";

function createKacheInstall(home) {
  const binaryName = process.platform === "win32" ? "kache.exe" : "kache";
  const install = path.join(home, ".local", "bin", binaryName);
  fs.mkdirSync(path.dirname(install), { recursive: true });
  fs.writeFileSync(install, "");
  return install;
}

function kacheFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kache-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, install: createKacheInstall(home) };
}

test("default cache dir prefers LOCALAPPDATA on Windows", () => {
  assert.equal(
    defaultKacheCacheDir({ LOCALAPPDATA: "D:\\Local" }, "win32"),
    path.join("D:\\Local", "kache"),
  );
  assert.equal(
    defaultKacheCacheDir({}, "linux"),
    path.join(os.homedir(), ".cache", "kache"),
  );
});

test("default Windows cache dir isolates concurrent GitHub runners", () => {
  assert.equal(
    defaultKacheCacheDir(
      { LOCALAPPDATA: "D:\\Local", RUNNER_NAME: "local-windows-x64-2" },
      "win32",
    ),
    path.join("D:\\Local", "kache-runners", "local-windows-x64-2", `v${KACHE_VERSION}`),
  );
  assert.equal(
    defaultKacheCacheDir(
      { LOCALAPPDATA: "D:\\Local", RUNNER_NAME: "runner name/unsafe" },
      "win32",
    ),
    path.join("D:\\Local", "kache-runners", "runner_name_unsafe", `v${KACHE_VERSION}`),
  );
  assert.equal(
    defaultKacheCacheDir(
      {
        LOCALAPPDATA: "D:\\Local",
        KACHE_GITHUB_RUNNER_NAME: "local-windows-x64",
        RUNNER_NAME: "runner",
      },
      "win32",
    ),
    path.join("D:\\Local", "kache-runners", "local-windows-x64", `v${KACHE_VERSION}`),
  );
});

test("resolveKacheBinary trusts an absolute RUSTC_WRAPPER path", () => {
  const marker = path.join(os.tmpdir(), `kache-wrapper-test-${process.pid}.exe`);
  fs.writeFileSync(marker, "");
  try {
    assert.equal(
      resolveKacheBinary({ RUSTC_WRAPPER: marker }, process.platform, os.homedir()),
      path.resolve(marker),
    );
  } finally {
    fs.unlinkSync(marker);
  }
});

test("resolveKacheBinary discovers the pinned accelerator-ci install", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kache-home-"));
  try {
    const binaryName = process.platform === "win32" ? "kache.exe" : "kache";
    const install = path.join(
      home,
      ".local",
      "accelerator-ci",
      "kache",
      `v${KACHE_VERSION}`,
      binaryName,
    );
    fs.mkdirSync(path.dirname(install), { recursive: true });
    fs.writeFileSync(install, "");
    assert.equal(resolveKacheBinary({}, process.platform, home), path.resolve(install));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("rustCompileCacheEnv keeps conservative Windows cache paths disabled", (t) => {
  const { home, install } = kacheFixture(t);

  const result = rustCompileCacheEnv(
    { PATH: path.dirname(install), LOCALAPPDATA: path.join(home, "Local") },
    { platform: "win32", home },
  );
  assert.equal(result.enabled, true);
  assert.equal(result.env.CARGO_INCREMENTAL, "0");
  assert.equal(result.env.RUSTC_WRAPPER, path.resolve(install));
  assert.equal(result.env.KACHE_CACHE_EXECUTABLES, "true");
  assert.match(result.env.KACHE_CONFIG, /scripts[\\/]kache\.toml$/u);
  assert.equal(result.env.KACHE_WINDOWS_HARDLINK, "true");
  assert.equal(result.env.KACHE_CACHE_DIR, path.join(home, "Local", "kache"));
  assert.equal(result.env.CARGO_TARGET_DIR, undefined);
  assert.match(result.detail, /cache_executables=true/);
  assert.match(result.detail, /windows_hardlink=true/);
});

test("rustCompileCacheEnv preserves explicit Windows kache cache paths", (t) => {
  const { home, install } = kacheFixture(t);

  const result = rustCompileCacheEnv(
    {
      PATH: path.dirname(install),
      RUSTC_WRAPPER: install,
      KACHE_CACHE_DIR: path.join(home, "custom-cache"),
      KACHE_CACHE_EXECUTABLES: "true",
      KACHE_WINDOWS_HARDLINK: "stale-setting",
    },
    { platform: "win32", home },
  );
  assert.equal(result.env.KACHE_CACHE_EXECUTABLES, "true");
  assert.equal(result.env.KACHE_WINDOWS_HARDLINK, "true");
  assert.match(result.env.KACHE_CONFIG, /scripts[\\/]kache\.toml$/u);
  assert.equal(result.env.KACHE_CACHE_DIR, path.join(home, "custom-cache"));
});

test("rustCompileCacheEnv reports missing kache without inventing a wrapper", () => {
  const result = rustCompileCacheEnv(
    { PATH: "", Path: "" },
    { platform: "linux", home: path.join(os.tmpdir(), `no-kache-${process.pid}`) },
  );
  assert.equal(result.enabled, false);
  assert.equal(result.env.RUSTC_WRAPPER, undefined);
  assert.equal(result.env.CARGO_INCREMENTAL, "0");
  assert.equal(result.env.CARGO_TARGET_DIR, undefined);
});
