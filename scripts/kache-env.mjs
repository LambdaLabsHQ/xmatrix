#!/usr/bin/env node
/**
 * Resolve kache for shared CI / pre-commit Rust builds.
 *
 * CI installs the pinned binary via .github/scripts/setup-kache.sh on Unix or
 * setup-kache.ps1 on Windows and exports RUSTC_WRAPPER + KACHE_CACHE_DIR. Local
 * developers may only have kache on PATH (or via ~/.cargo/config.toml). This
 * helper makes the wrapper explicit for both paths without skipping checks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Keep in sync with .github/scripts/setup-kache.sh and setup-kache.ps1.
export const KACHE_VERSION = "0.10.0";
const KACHE_CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "kache.toml",
);

function isUsableFile(candidate) {
  if (!candidate) return false;
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function defaultKacheCacheDir(env = process.env, platform = process.platform) {
  if (env.KACHE_CACHE_DIR) return env.KACHE_CACHE_DIR;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const runnerName = env.KACHE_GITHUB_RUNNER_NAME || env.RUNNER_NAME;
    if (runnerName) {
      let runnerCacheKey = runnerName.trim().replaceAll(/[^A-Za-z0-9_.-]/g, "_");
      if (!runnerCacheKey || runnerCacheKey === "." || runnerCacheKey === "..") {
        throw new Error("GitHub runner name cannot form a safe kache cache key");
      }
      if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(runnerCacheKey)) {
        runnerCacheKey = `_${runnerCacheKey}`;
      }
      return path.join(base, "kache-runners", runnerCacheKey, `v${KACHE_VERSION}`);
    }
    return path.join(base, "kache");
  }
  return path.join(os.homedir(), ".cache", "kache");
}

export function kacheInstallCandidates(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const binary = platform === "win32" ? "kache.exe" : "kache";
  const candidates = [
    path.join(home, ".local", "accelerator-ci", "kache", `v${KACHE_VERSION}`, binary),
    path.join(home, ".local", "bin", binary),
  ];

  const pathEnv = env.PATH || env.Path || "";
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    candidates.push(path.join(dir, binary));
    if (platform === "win32") candidates.push(path.join(dir, "kache"));
  }
  return candidates;
}

export function resolveKacheBinary(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const configured = (env.RUSTC_WRAPPER || "").trim();
  if (configured) {
    if (configured === "kache" || configured === "kache.exe") {
      // Fall through to PATH / install-dir discovery so we pin an absolute path.
    } else if (isUsableFile(configured)) {
      return path.resolve(configured);
    } else {
      // Trust CI-provided absolute paths even when this process cannot stat them
      // (different mount namespaces, delayed path materialization, etc.).
      return configured;
    }
  }

  for (const candidate of kacheInstallCandidates(env, platform, home)) {
    if (isUsableFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

/**
 * Build the env block for cargo invocations under scripts/ci.mjs.
 * Does not remove any checks; only adds compile-cache configuration.
 * Leaves cargo's default in-package target dir so concurrent jobs stay isolated.
 */
export function rustCompileCacheEnv(
  baseEnv = process.env,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const env = { ...baseEnv, CARGO_INCREMENTAL: "0" };
  const kache = resolveKacheBinary(env, platform, home);

  if (!kache) {
    return {
      env,
      kache: null,
      cacheDir: null,
      enabled: false,
      detail: "kache binary not found; cargo will build without an explicit compile-cache wrapper",
    };
  }

  env.RUSTC_WRAPPER = kache;
  env.KACHE_CACHE_DIR = defaultKacheCacheDir(env, platform);
  // Keep the configuration in-repo while exporting the same values for
  // wrapper-only invocations. Local hooks and every CI runner then share
  // executable caching and Windows hard-link restoration.
  env.KACHE_CONFIG = KACHE_CONFIG_PATH;

  // Full kache utilization on every platform, including Windows PE restores.
  // Do not use a shared CARGO_TARGET_DIR; kache is the cross-job compile cache.
  env.KACHE_CACHE_EXECUTABLES = "true";
  if (platform === "win32") {
    env.KACHE_WINDOWS_HARDLINK = "true";
  }

  return {
    env,
    kache,
    cacheDir: env.KACHE_CACHE_DIR,
    enabled: true,
    detail:
      `wrapper=${kache} cache=${env.KACHE_CACHE_DIR}` +
      ` cache_executables=${env.KACHE_CACHE_EXECUTABLES}` +
      ` config=${env.KACHE_CONFIG}` +
      (platform === "win32" ? " windows_hardlink=true" : ""),
  };
}
