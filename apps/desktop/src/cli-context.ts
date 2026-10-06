import { spawn } from "node:child_process";

/**
 * The App's view of the CLI's credential store, read from `xmatrix session
 * show --json`. The App never parses session files or the profile registry
 * itself: the binary that writes them is the one that reads them.
 */
export type DesktopCliProfile = {
  id: string;
  name: string;
  hubUrl: string;
  stateRoot: string;
  revision: number;
  stateKind: "legacy-root" | "isolated";
};

export type DesktopCliSession = {
  hubUrl: string;
  relayUrl: string;
  user: { id: string; email: string; name?: string };
  updatedAt: string;
  expiresAt: string;
  /** Present only when read with `withToken`; the App's own sync transport needs it. */
  token?: string;
};

export type DesktopCliContext = {
  hubUrl: string;
  profile: DesktopCliProfile | null;
  session: DesktopCliSession | null;
  machineId: string | null;
};

export type DesktopCliSessionImportOutcome = {
  hubUrl: string;
  userId: string;
  updatedAt: string;
  expiresAt: string;
  daemon: "reloaded" | "already-current" | "unavailable" | "unsupported" | "machine-name-required";
};

export type CliRunner = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; input?: string },
) => Promise<{ stdout: string; stderr: string }>;

/** Runs the CLI with optional stdin; rejects with its stderr on a non-zero exit. */
export const defaultCliRunner: CliRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} ${args.join(" ")} timed out`));
    }, options.timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout).trim() || `${file} exited with ${code}`));
    });
    child.stdin.end(options.input ?? "");
  });

/**
 * The binary that owns the credential store: an installed CLI first, then the
 * App's bundled seed (a complete CLI), then a bare name for PATH lookup.
 */
/**
 * Whether a running daemon is a new process since the last one seen. A new
 * process may come from a CLI that updated itself, and that CLI names this
 * Machine's id, so its context is read again. The first daemon seen needs no
 * re-read: the context was read at startup.
 */
export function daemonProcessChangeTracker(): (pid?: number) => boolean {
  let last: number | undefined;
  return (pid) => {
    if (!pid || pid === last) return false;
    const replaced = last !== undefined;
    last = pid;
    return replaced;
  };
}

export function resolveSessionCli(options: {
  installed: string | null;
  seed: string;
  exists: (candidate: string) => boolean;
  isAbsolute: (candidate: string) => boolean;
}): string | null {
  const { installed } = options;
  if (installed && options.isAbsolute(installed) && options.exists(installed)) return installed;
  if (options.exists(options.seed)) return options.seed;
  if (installed && !options.isAbsolute(installed)) return installed;
  return null;
}

export function sessionCliArgs(
  command: "show" | "import",
  options: { profileId?: string; withToken?: boolean } = {},
): string[] {
  return [
    ...(options.profileId ? ["--profile", options.profileId] : []),
    "session",
    command,
    ...(command === "import" ? ["--stdin"] : []),
    "--json",
    ...(command === "show" && options.withToken ? ["--with-token"] : []),
  ];
}

function lastJsonLine(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Not the report line.
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Returns null whenever the CLI cannot answer; callers treat that as "no local context". */
export async function readCliContext(options: {
  executable: string;
  profileId?: string;
  withToken?: boolean;
  env: NodeJS.ProcessEnv;
  run: CliRunner;
}): Promise<DesktopCliContext | null> {
  let report: Record<string, unknown> | null;
  try {
    const { stdout } = await options.run(
      options.executable,
      sessionCliArgs("show", { profileId: options.profileId, withToken: options.withToken }),
      { env: options.env, timeout: 15_000 },
    );
    report = lastJsonLine(stdout);
  } catch {
    return null;
  }
  if (!report || typeof report.hubUrl !== "string") return null;
  const profile = report.profile && typeof report.profile === "object"
    ? report.profile as Record<string, unknown>
    : null;
  const session = report.session && typeof report.session === "object"
    ? report.session as Record<string, unknown>
    : null;
  const user = session?.user && typeof session.user === "object" ? session.user as Record<string, unknown> : null;
  return {
    hubUrl: report.hubUrl,
    profile: profile
      && typeof profile.id === "string"
      && typeof profile.name === "string"
      && typeof profile.hubUrl === "string"
      && typeof profile.stateRoot === "string"
      && typeof profile.revision === "number"
      && (profile.stateKind === "legacy-root" || profile.stateKind === "isolated")
      ? {
          id: profile.id,
          name: profile.name,
          hubUrl: profile.hubUrl,
          stateRoot: profile.stateRoot,
          revision: profile.revision,
          stateKind: profile.stateKind,
        }
      : null,
    session: session && user && typeof session.hubUrl === "string" && typeof user.id === "string"
      ? {
          hubUrl: session.hubUrl,
          relayUrl: stringOrNull(session.relayUrl) ?? "",
          user: {
            id: user.id,
            email: stringOrNull(user.email) ?? "",
            ...(typeof user.name === "string" ? { name: user.name } : {}),
          },
          updatedAt: stringOrNull(session.updatedAt) ?? "",
          expiresAt: stringOrNull(session.expiresAt) ?? "",
          ...(typeof session.token === "string" ? { token: session.token } : {}),
        }
      : null,
    machineId: stringOrNull(report.machineId),
  };
}

/** Hands a Hub session to the CLI over stdin; the CLI saves it and rings the daemon. */
export async function importCliSession(options: {
  executable: string;
  profileId?: string;
  payload: unknown;
  env: NodeJS.ProcessEnv;
  run: CliRunner;
}): Promise<DesktopCliSessionImportOutcome> {
  const { stdout } = await options.run(
    options.executable,
    sessionCliArgs("import", { profileId: options.profileId }),
    { env: options.env, timeout: 30_000, input: `${JSON.stringify(options.payload)}\n` },
  );
  const report = lastJsonLine(stdout);
  const daemon = report?.daemon;
  if (
    !report
    || typeof report.hubUrl !== "string"
    || typeof report.userId !== "string"
    || (daemon !== "reloaded" && daemon !== "already-current" && daemon !== "unavailable" && daemon !== "unsupported" && daemon !== "machine-name-required")
  ) {
    throw new Error("The xMatrix CLI did not report a session import result.");
  }
  return {
    hubUrl: report.hubUrl,
    userId: report.userId,
    updatedAt: stringOrNull(report.updatedAt) ?? "",
    expiresAt: stringOrNull(report.expiresAt) ?? "",
    daemon,
  };
}
