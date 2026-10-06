import fs from "node:fs";
import path from "node:path";

type Platform = NodeJS.Platform | string;

type CliPathOptions = {
  platform?: Platform;
  homeDir: string;
  envCliPath?: string;
};

type ResolveCliExecutableOptions = CliPathOptions & {
  envPath?: string;
  desktopExecPath?: string;
  exists?: (candidate: string) => boolean;
};

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"];

function platformPath(platform: Platform | undefined) {
  return platform === "win32" ? path.win32 : path;
}

function pathDelimiter(platform: Platform | undefined) {
  return platform === "win32" ? ";" : path.delimiter;
}

export function cliPathCandidates(options: CliPathOptions): string[] {
  const platform = options.platform || process.platform;
  const pathApi = platformPath(platform);
  const baseNames = platform === "win32"
    ? ["xmatrix.exe", "xmatrix.cmd", "xmatrix.bat", "xmatrix"]
    : ["xmatrix"];
  return [
    options.envCliPath,
    pathApi.join(options.homeDir, ".cargo", "bin", platform === "win32" ? "xmatrix.exe" : "xmatrix"),
    "/usr/local/bin/xmatrix",
    "/opt/homebrew/bin/xmatrix",
    pathApi.join(options.homeDir, ".local", "bin", platform === "win32" ? "xmatrix.exe" : "xmatrix"),
    pathApi.join(options.homeDir, "bin", platform === "win32" ? "xmatrix.exe" : "xmatrix"),
    ...baseNames,
  ].filter(Boolean) as string[];
}

export function defaultUserBinPaths(options: CliPathOptions): string[] {
  const platform = options.platform || process.platform;
  const pathApi = platformPath(platform);
  return [
    pathApi.join(options.homeDir, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    pathApi.join(options.homeDir, ".local", "bin"),
    pathApi.join(options.homeDir, "bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

export function augmentPath(value: string | undefined, options: CliPathOptions): string {
  const platform = options.platform || process.platform;
  const delimiter = pathDelimiter(platform);
  const seen = new Set<string>();
  const parts = [...(value || "").split(delimiter), ...defaultUserBinPaths(options)]
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const key = platform === "win32" ? part.toLowerCase() : part;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  return parts.join(delimiter);
}

export function executableExists(
  executable: string,
  options: Pick<ResolveCliExecutableOptions, "platform" | "exists"> = {}
): boolean {
  if (!path.isAbsolute(executable) && options.platform !== "win32") {
    return true;
  }

  if (options.exists) {
    return options.exists(executable);
  }

  try {
    fs.accessSync(
      executable,
      options.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK
    );
    return true;
  } catch {
    return false;
  }
}

export function isDesktopExecutablePath(
  executable: string,
  options: Pick<ResolveCliExecutableOptions, "platform" | "desktopExecPath"> = {}
): boolean {
  const desktopExecPath = options.desktopExecPath;
  if (!desktopExecPath) {
    return false;
  }
  const platform = options.platform || process.platform;
  const pathApi = platformPath(platform);
  const candidate = pathApi.normalize(pathApi.resolve(executable));
  const desktop = pathApi.normalize(pathApi.resolve(desktopExecPath));
  return platform === "win32"
    ? candidate.toLowerCase() === desktop.toLowerCase()
    : candidate === desktop;
}

function windowsExecutableVariants(candidate: string): string[] {
  const ext = path.win32.extname(candidate);
  if (ext) {
    return [candidate];
  }
  return WINDOWS_EXECUTABLE_EXTENSIONS.map((suffix) => `${candidate}${suffix}`);
}

export function resolveWindowsExecutableFromPath(
  candidate: string,
  options: ResolveCliExecutableOptions
): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const hasPathSeparator = trimmed.includes("\\") || trimmed.includes("/");
  const searchDirs = hasPathSeparator || path.win32.isAbsolute(trimmed)
    ? [""]
    : [
        ...(options.envPath || "").split(";"),
        ...defaultUserBinPaths({ ...options, platform: "win32" }),
      ];

  for (const searchDir of searchDirs) {
    if (!searchDir.trim() && !hasPathSeparator && !path.win32.isAbsolute(trimmed)) {
      continue;
    }
    const base = searchDir ? path.win32.join(searchDir, trimmed) : trimmed;
    for (const executable of windowsExecutableVariants(base)) {
      if (!executableExists(executable, { ...options, platform: "win32" })) {
        continue;
      }
      if (isDesktopExecutablePath(executable, { ...options, platform: "win32" })) {
        continue;
      }
      return executable;
    }
  }

  return null;
}

export function resolveCliExecutable(options: ResolveCliExecutableOptions): string | null {
  const platform = options.platform || process.platform;
  for (const candidate of cliPathCandidates(options)) {
    if (platform === "win32") {
      const resolved = resolveWindowsExecutableFromPath(candidate, options);
      if (resolved) return resolved;
      continue;
    }
    if (executableExists(candidate, options)) return candidate;
  }
  return platform === "win32" ? null : "xmatrix";
}
