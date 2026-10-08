#!/usr/bin/env node
// Runs a command with the Web app's Next.js build cache carried across CI
// checkouts. A clean checkout loses apps/web/.next/cache, so every CI build
// was a cold webpack compile. Each runner keeps its own copy in the runner
// home (one job per runner at a time, so nothing writes it concurrently),
// moves it into place before the command and back afterwards, whether the
// command passed or not. Webpack validates every cached module against its
// inputs, so a stale entry costs a recompile, never a wrong build.
//
// Usage: node scripts/next-build-cache.mjs -- <command> [args...]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isCliMain } from "./cli-entrypoint.mjs";
import { rootDir } from "./repository-paths.mjs";

// Beyond this the cache is dropped and rebuilt, so it cannot grow without bound.
const MAX_CACHE_BYTES = 2 * 1024 ** 3;

export function nextBuildCacheDir(env = process.env, home = os.homedir()) {
  if (env.XMATRIX_NEXT_CACHE_DIR) return env.XMATRIX_NEXT_CACHE_DIR;
  if (!env.CI || !env.RUNNER_NAME || !/^[A-Za-z0-9._-]+$/u.test(env.RUNNER_NAME)) return null;
  return path.join(home, ".cache", "xmatrix", "next-cache", env.RUNNER_NAME);
}

function directoryBytes(directory) {
  // POSIX -sk works on both the Linux CI runners and BSD/macOS du. GNU -b
  // was rejected on macOS and silently treated an oversized cache as empty.
  const result = spawnSync("du", ["-sk", directory], { encoding: "utf8", timeout: 10_000 });
  const kibibytes = Number(result.stdout?.trim().split(/\s+/u)[0]);
  return result.status === 0 && Number.isFinite(kibibytes) ? kibibytes * 1024 : Infinity;
}

function move(from, to) {
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
    return true;
  } catch (error) {
    console.log(`[next-cache] could not move ${from} -> ${to}: ${error.message}; continuing without it`);
    return false;
  }
}

export function runWithNextBuildCache(command, args, {
  cacheDir = nextBuildCacheDir(),
  appCacheDir = path.join(rootDir, "apps/web/.next/cache"),
  maxBytes = MAX_CACHE_BYTES,
  run = (file, argv) => spawnSync(file, argv, { stdio: "inherit", shell: process.platform === "win32" }),
} = {}) {
  if (cacheDir && existsSync(cacheDir) && !existsSync(appCacheDir)) {
    if (move(cacheDir, appCacheDir)) console.log(`[next-cache] restored ${cacheDir}`);
  }
  const result = run(command, args);
  if (cacheDir && existsSync(appCacheDir)) {
    if (directoryBytes(appCacheDir) > maxBytes) {
      rmSync(appCacheDir, { recursive: true, force: true });
      console.log("[next-cache] cache exceeded its budget; dropped it");
    } else if (move(appCacheDir, cacheDir)) {
      console.log(`[next-cache] saved ${cacheDir}`);
    }
  }
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (isCliMain(import.meta.url)) {
  const separator = process.argv.indexOf("--");
  const [command, ...args] = separator >= 0 ? process.argv.slice(separator + 1) : [];
  if (!command) {
    console.error("Usage: node scripts/next-build-cache.mjs -- <command> [args...]");
    process.exit(2);
  }
  process.exit(runWithNextBuildCache(command, args));
}
