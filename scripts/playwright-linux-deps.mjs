#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "..");

export function parseMissingPackages(output) {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) =>
    /^Missing system dependencies \(\d+\):$/.test(line.trim()),
  );
  if (header === -1) return [];

  const packages = [];
  for (const line of lines.slice(header + 1)) {
    const match = /^\s{2}(\S+)\s*$/.exec(line);
    if (!match) break;
    packages.push(match[1]);
  }
  return packages;
}

export function playwrightLinuxLibraryPath(cacheDir, existing = "") {
  const current = path.join(cacheDir, "current");
  return [
    path.join(current, "usr", "lib", "x86_64-linux-gnu"),
    path.join(current, "lib", "x86_64-linux-gnu"),
    path.join(current, "usr", "lib64"),
    path.join(current, "lib64"),
    path.join(current, "usr", "lib"),
    path.join(current, "lib"),
    existing,
  ]
    .filter(Boolean)
    .join(path.delimiter);
}

function commandEnv() {
  return {
    ...process.env,
    http_proxy: process.env.http_proxy || process.env.HTTP_PROXY,
    https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: commandEnv(),
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

async function playwrightDependencyDryRun() {
  const shimDir = await mkdtemp(path.join(os.tmpdir(), "xmatrix-playwright-apt-"));
  const aptShim = path.join(shimDir, "apt-get");
  const shim = `#!/usr/bin/env bash
set -euo pipefail

real_apt_get="/usr/bin/apt-get"
if [[ ! -x "$real_apt_get" ]]; then
  echo "required apt-get executable is missing: $real_apt_get" >&2
  exit 127
fi

# Ask apt-cache about every package in one call: one call per package
# reloaded the package cache each time and took ~30s per job.
packages=()
seen_flag=false
for argument in "$@"; do
  if [[ "$argument" == "--no-install-recommends" ]]; then
    seen_flag=true
  elif [[ "$seen_flag" == "true" && "$argument" != -* ]]; then
    packages+=("$argument")
  fi
done
declare -A available=()
if (( \${#packages[@]} > 0 )); then
  while read -r package; do
    available["$package"]=1
  done < <(apt-cache policy "\${packages[@]}" 2>/dev/null | awk '
    /^[^[:space:]].*:$/ { package = substr($0, 1, length($0) - 1); next }
    /^[[:space:]]*Candidate:/ { if ($2 != "" && $2 != "(none)") print package }
  ')
fi

filter_packages=false
filtered=()
for argument in "$@"; do
  if [[ "$argument" == "--no-install-recommends" ]]; then
    filter_packages=true
    filtered+=("$argument")
    continue
  fi
  if [[ "$filter_packages" == "true" && "$argument" != -* && -z "\${available[$argument]:-}" ]]; then
    echo "Skipping unavailable optional Playwright package: $argument" >&2
    continue
  fi
  filtered+=("$argument")
done

exec "$real_apt_get" "\${filtered[@]}"
`;

  try {
    await writeFile(aptShim, shim, "utf8");
    await chmod(aptShim, 0o755);
    return spawnSync(
      process.execPath,
      [
        path.join(
          rootDir,
          "apps",
          "web",
          "node_modules",
          "@playwright",
          "test",
          "cli.js",
        ),
        "install",
        "--with-deps",
        "--dry-run",
        "chromium",
      ],
      {
        cwd: rootDir,
        env: {
          ...commandEnv(),
          PATH: `${shimDir}${path.delimiter}${process.env.PATH || ""}`,
        },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
}

function assertChildPath(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside cache directory: ${child}`);
  }
}

async function pointCurrentAt(cacheDir, targetDir) {
  const current = path.join(cacheDir, "current");
  const temporary = path.join(cacheDir, `.current-${process.pid}`);
  await rm(temporary, { force: true });
  await symlink(path.basename(targetDir), temporary, "dir");
  await rm(current, { force: true });
  await rename(temporary, current);
}

async function install(cacheDir) {
  if (process.platform !== "linux") {
    throw new Error("Playwright user-space dependencies are only supported on Linux.");
  }

  // Playwright includes several optional font packages in its Ubuntu tool
  // list. Minimal runner images can omit the corresponding apt repository;
  // filter only packages with no candidate before asking apt which available
  // runtime libraries are actually missing.
  const dryRun = await playwrightDependencyDryRun();
  if (dryRun.error) throw dryRun.error;

  const output = `${dryRun.stdout || ""}\n${dryRun.stderr || ""}`;
  const packages = parseMissingPackages(output);
  if (dryRun.status !== 0 && packages.length === 0) {
    throw new Error(output.trim() || "Could not determine missing Playwright dependencies.");
  }

  const manifest = JSON.parse(
    await readFile(
      path.join(
        rootDir,
        "apps",
        "web",
        "node_modules",
        "@playwright",
        "test",
        "package.json",
      ),
      "utf8",
    ),
  );
  const osRelease = await readFile("/etc/os-release", "utf8");
  const signature = JSON.stringify({
    playwrightVersion: manifest.version,
    osRelease,
    packages,
  });
  const cacheKey = createHash("sha256")
    .update(signature)
    .digest("hex")
    .slice(0, 16);
  const targetDir = path.join(cacheDir, cacheKey);
  const markerPath = path.join(targetDir, ".complete");

  await mkdir(targetDir, { recursive: true });
  let complete = false;
  try {
    complete = (await readFile(markerPath, "utf8")) === signature;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (!complete && packages.length > 0) {
    const downloadDir = path.join(targetDir, `.downloads-${process.pid}`);
    assertChildPath(targetDir, downloadDir);
    await rm(downloadDir, { recursive: true, force: true });
    await mkdir(downloadDir, { recursive: true });
    try {
      run("apt-get", ["download", ...packages], { cwd: downloadDir });
      const archives = (await readdir(downloadDir)).filter((name) => name.endsWith(".deb"));
      if (archives.length === 0) {
        throw new Error("apt-get did not download any dependency archives.");
      }
      for (const archive of archives) {
        run("dpkg-deb", ["--extract", path.join(downloadDir, archive), targetDir]);
      }
      await writeFile(markerPath, signature, "utf8");
    } finally {
      await rm(downloadDir, { recursive: true, force: true });
    }
  } else if (!complete) {
    await writeFile(markerPath, signature, "utf8");
  }

  await mkdir(cacheDir, { recursive: true });
  await pointCurrentAt(cacheDir, targetDir);
  console.log(
    packages.length > 0
      ? `Playwright Linux dependencies ready in ${targetDir}.`
      : "Playwright Linux dependencies are already installed system-wide.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const cacheDir = path.resolve(
    process.argv[2] || path.join(os.homedir(), ".cache", "xmatrix", "playwright-linux-deps"),
  );
  install(cacheDir).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
