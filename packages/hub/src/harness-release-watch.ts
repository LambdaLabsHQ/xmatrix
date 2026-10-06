import { AGENT_PRESETS, type AgentPreset } from "@xmatrix/protocol";
import { readHarnessReleaseTargets, type AuthorityDatabaseSession, type HarnessReleaseTarget } from "@xmatrix/db";
import { postgresAuthorityDatabase } from "./postgres-authority-http";
import { machineDaemonCommand } from "./machines";
import type { Env } from "./types";

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
  targets?: (input: { presetId: string; version: string }) => Promise<HarnessReleaseTarget[]>;
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
  const targets = dependencies.targets ?? (input => readHarnessReleaseTargets(database!,
    { requestId: `harness-release:${crypto.randomUUID()}`, ...input }));
  const latestOf = dependencies.latest ?? (latest => fetchLatestVersion(latest));
  let issued = 0;
  try {
    const watched = (dependencies.presets ?? AGENT_PRESETS)
      .flatMap(preset => preset.management?.latest ? [{ preset, latest: preset.management.latest }] : []);
    const versions = await Promise.all(watched.map(({ latest }) => latestOf(latest)));
    for (const [index, { preset }] of watched.entries()) {
      const version = versions[index];
      if (!version) continue;
      for (const target of await targets({ presetId: preset.id, version })) {
        const requestId = `harness:${crypto.randomUUID()}`;
        try {
          await (dependencies.issue ?? (command => machineDaemonCommand(env, command)))({
            ownerUserId: target.ownerUserId, ownerEmail: target.ownerEmail, machineId: target.machineId,
            hostId: target.hostId, daemonId: target.daemonId,
            commandId: `issue:${requestId}`, action: "issue", controlId: requestId, commandType: "harness_action",
            principal: { kind: "user", id: target.ownerUserId },
            payload: { type: "machine_harness_action", requestId, presetId: preset.id, action: "release" },
          });
          issued++;
        } catch (error) {
          // An untold daemon stays a target and is told on a later pass.
          console.warn("Harness release notice failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  } finally {
    await database?.close();
  }
  return { issued };
}
