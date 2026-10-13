import { AGENT_PRESETS, type AgentPreset } from "@xmatrix/protocol";
import { readHarnessReleaseTargets, type AuthorityDatabaseSession, type HarnessReleaseTarget } from "@xmatrix/db";
import { postgresAuthorityDatabase } from "./postgres-authority-http";
import { machineDaemonCommand } from "./machines";
import { relayRuntimeSingleCell } from "./relay-authority-locator";
import { failureResponse, transientFailure } from "./error-contract";
import type { Env } from "./types";

/** The Runtime cell route that runs one release pass beside PostgreSQL. */
export const RELAY_RUNTIME_HARNESS_RELEASE_WATCH_PATH = "/internal/product-control/harness-release-watch";

const FETCH_TIMEOUT_MS = 5_000;
/** npm `latest` documents carry the readme and PyPI JSON lists every release. */
const MAX_BODY_BYTES = 1024 * 1024;
const VERSION = /^[A-Za-z0-9.+-]{1,128}$/u;
/** An npm (optionally scoped) or PyPI name; never a path segment like `..`. */
const PACKAGE = /^(?=.{1,214}$)(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

type Latest = NonNullable<NonNullable<AgentPreset["management"]>["latest"]>;

export function latestVersionUrl(latest: Latest): string | undefined {
  if (!PACKAGE.test(latest.package)) return undefined;
  return latest.kind === "npm"
    ? `https://registry.npmjs.org/${latest.package.replace("/", "%2f")}/latest`
    : `https://pypi.org/pypi/${latest.package}/json`;
}

export function latestVersionFromBody(kind: Latest["kind"], body: unknown): string | undefined {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
  const info = record?.info && typeof record.info === "object" ? record.info as Record<string, unknown> : undefined;
  const version = kind === "npm" ? record?.version : info?.version;
  return typeof version === "string" && VERSION.test(version) ? version : undefined;
}

/** The registry's current latest version; any failure is `undefined`, never a guess. */
export async function fetchLatestVersion(latest: Latest, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const url = latestVersionUrl(latest);
  if (!url) return undefined;
  try {
    const response = await fetcher(url, { headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok || !response.body) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return latestVersionFromBody(latest.kind, JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

export interface HarnessReleaseWatchDependencies {
  presets?: readonly AgentPreset[];
  latest?: (latest: Latest) => Promise<string | undefined>;
  targets?: (releases: { presetId: string; version: string }[]) => Promise<HarnessReleaseTarget[]>;
  /** Issues one daemon command; the Machine repository by default. */
  issue?: (command: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Official registries publish no push feed, so the Hub reads each preset's
 * registry once a minute and tells only the daemons whose reported inventory
 * has not seen that version. A `release` command names the preset alone: the
 * daemon reads the registry itself and applies its own automatic-update policy.
 */
export async function watchHarnessReleases(env: Env, dependencies: HarnessReleaseWatchDependencies = {}):
  Promise<{ issued: number }> {
  const database: AuthorityDatabaseSession | undefined = dependencies.targets ? undefined
    : postgresAuthorityDatabase(env, "Machine", "xmatrix-hub-harness-release").openSession();
  const targets = dependencies.targets ?? (releases => readHarnessReleaseTargets(database!,
    { requestId: `harness-release:${crypto.randomUUID()}`, releases }));
  const latestOf = dependencies.latest ?? (latest => fetchLatestVersion(latest));
  let issued = 0;
  try {
    const watched = (dependencies.presets ?? AGENT_PRESETS)
      .flatMap(preset => preset.management?.latest ? [{ preset, latest: preset.management.latest }] : []);
    const versions = await Promise.all(watched.map(({ latest }) => latestOf(latest)));
    const releases = watched.flatMap(({ preset }, index) => {
      const version = versions[index];
      return version ? [{ presetId: preset.id, version }] : [];
    });
    if (releases.length === 0) return { issued };
    for (const target of await targets(releases)) {
      const requestId = `harness:${crypto.randomUUID()}`;
      try {
        await (dependencies.issue ?? (command => machineDaemonCommand(env, command)))({
          ownerUserId: target.ownerUserId, ownerEmail: target.ownerEmail, machineId: target.machineId,
          hostId: target.hostId, daemonId: target.daemonId,
          commandId: `issue:${requestId}`, action: "issue", controlId: requestId, commandType: "harness_action",
          principal: { kind: "user", id: target.ownerUserId },
          payload: { type: "machine_harness_action", requestId, presetId: target.presetId, action: "release" },
        });
        issued++;
      } catch (error) {
        // An untold daemon stays a target and is told on a later pass.
        console.warn("Harness release notice failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    await database?.close();
  }
  return { issued };
}

/**
 * A cron trigger is not placed: it runs wherever Cloudflare starts it, about
 * 250 ms from PostgreSQL per round trip, while the Worker's requests run beside
 * it. A release notice is an `issue` that holds the Machine's control lock for
 * its ten round trips, so issued from there it held the lock for 2-3.5 s and
 * the daemon's own claim or renew behind it failed with `lock_timeout`
 * (XMATRIX-HUB-7K). The pass runs in a Runtime cell, which is created next to
 * the database, so each notice holds the lock for milliseconds.
 */
export async function watchHarnessReleasesBesidePostgres(
  env: Pick<Env, "RELAY_RUNTIME" | "XMATRIX_RUNTIME_LOCATION_HINT">,
): Promise<{ issued: number }> {
  const response = await relayRuntimeSingleCell(env).fetch(new Request(
    `https://relay-runtime${RELAY_RUNTIME_HARNESS_RELEASE_WATCH_PATH}`, { method: "POST" }));
  const body = await response.json<Record<string, unknown>>();
  if (response.ok && typeof body.issued === "number") return { issued: body.issued };
  // The cell already logged an outage; a defect it threw rejects the fetch instead.
  if (body.retryable === true) return { issued: 0 };
  throw new Error(`Harness release watch answered ${response.status}: ${String(body.error ?? "no error")}`);
}

/** The Runtime cell's side: one pass, with an outage answered as retryable rather than thrown. */
export async function answerHarnessReleaseWatch(
  env: Env,
  watch: (env: Env) => Promise<{ issued: number }> = watchHarnessReleases,
): Promise<Response> {
  try {
    return Response.json(await watch(env), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = transientFailure(error);
    if (failure) return failureResponse(failure, { "cache-control": "no-store" });
    throw error;
  }
}
