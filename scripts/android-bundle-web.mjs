#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { rootDir } from "./repository-paths.mjs";

const webDir = path.join(rootDir, "apps", "web");
const androidAssetsDir = path.join(rootDir, "apps", "android", "app", "src", "main", "assets", "xmatrix-web");
const canonicalVersion = JSON.parse(fs.readFileSync(path.join(rootDir, "version.json"), "utf8")).version;

function run(command, args, options = {}) {
  console.log(`Running ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });

  if (result.error) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function copyDirectory(from, to) {
  if (!fs.existsSync(from)) {
    throw new Error(`Required directory not found: ${path.relative(rootDir, from)}`);
  }

  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}

function copyFileIfExists(from, targets) {
  if (!fs.existsSync(from)) {
    return false;
  }
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
  }
  return true;
}

if (process.env.SKIP_ANDROID_WEB_BUILD !== "1") {
  run("pnpm", ["--filter", "@xmatrix/protocol", "build"]);
  run("pnpm", ["--filter", "@xmatrix/web", "build"]);
}

const nextStaticDir = path.join(webDir, ".next", "static");
const nextServerAppDir = path.join(webDir, ".next", "server", "app");

fs.rmSync(androidAssetsDir, { recursive: true, force: true });
fs.mkdirSync(androidAssetsDir, { recursive: true });

copyDirectory(nextStaticDir, path.join(androidAssetsDir, "next", "static"));
copyDirectory(path.join(webDir, "public"), androidAssetsDir);

const htmlRoutes = [
  ["index.html", ["index.html"]],
  ["app.html", ["app.html", path.join("app", "index.html")]],
  ["login.html", ["login.html", path.join("login", "index.html")]],
  ["docs.html", ["docs.html", path.join("docs", "index.html")]],
  ["download.html", ["download.html", path.join("download", "index.html")]],
  ["console.html", ["console.html", path.join("console", "index.html")]],
];

for (const [sourceName, targetNames] of htmlRoutes) {
  copyFileIfExists(
    path.join(nextServerAppDir, sourceName),
    targetNames.map((targetName) => path.join(androidAssetsDir, targetName)),
  );
}

if (!fs.existsSync(path.join(androidAssetsDir, "app.html"))) {
  throw new Error("Packaged /app HTML was not generated. Ensure apps/web/src/app/app can be statically prerendered.");
}

const buildIdPath = path.join(webDir, ".next", "BUILD_ID");
const manifest = {
  version: canonicalVersion,
  buildId: fs.existsSync(buildIdPath) ? fs.readFileSync(buildIdPath, "utf8").trim() : null,
  generatedAt: new Date().toISOString(),
  startPath: "/app",
};

fs.writeFileSync(
  path.join(androidAssetsDir, "xmatrix-android-web-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`Bundled Android web assets in ${path.relative(rootDir, androidAssetsDir)}`);
