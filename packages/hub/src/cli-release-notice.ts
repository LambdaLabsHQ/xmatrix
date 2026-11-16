import { cliReleaseChannelOf, readBoundedStream, type CliReleaseChannel,
  type MachineDaemonCliReleaseNotice } from "@xmatrix/protocol";
import { readCliReleaseOwners } from "@xmatrix/db";
import { postgresAuthorityDatabase } from "./postgres-authority-http";
import { relayRuntimeCellsForOwners } from "./relay-authority-locator";
import { RELAY_RUNTIME_CLI_RELEASE_NOTICE_PATH } from "./runtime-transport/relay-runtime-product-adapter";
import { analyticsWorkerVersion } from "./analytics-sampling";
import { CliReleaseNoticeFailure, cliReleaseNoticeEvidence, type CliReleaseNoticeEvidence } from "./cli-release-notice-failure";
import type { Env } from "./types";

/**
 * The release feeds the CLI itself updates from (`xmatrix_cli_update`): a
 * stable build follows the first, a beta the second.
 */
export const CLI_RELEASE_FEEDS: Readonly<Record<CliReleaseChannel, string>> = {
  stable: "https://xmatrix.sh/api/cli/releases/latest",
  dev: "https://xmatrix.sh/api/cli/releases/dev",
};

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Both channel feeds, settled before the caller continues.
 *
 * One invocation may have six connections waiting on headers, and each
 * scheduled pass opens its own Hyperdrive connection. A feed fetch started
 * among them sits in that queue, and its five-second abort is not observed
 * until a slot frees — Hyperdrive's connect wait is 15 seconds (HUB-BX).
 * Reading both feeds here, with no other header-wait open, keeps a lost
 * response inside the deadline.
 */
export async function readCliReleaseFeeds(fetcher: typeof fetch = fetch):
  Promise<(channel: CliReleaseChannel) => Promise<string>> {
  const versions = new Map<CliReleaseChannel, Promise<string>>(
    (["stable", "dev"] as const).map(channel => [channel, fetchCliChannelVersion(channel, fetcher)]));
  await Promise.all([...versions.values()].map(version => version.catch(() => undefined)));
  return channel => {
    const version = versions.get(channel);
    if (!version) throw new Error(`CLI ${channel} release feed was not read`);
    return version;
  };
}

/** The newest release a channel's feed names; a feed that names none of that channel is an error. */
export async function fetchCliChannelVersion(channel: CliReleaseChannel, fetcher: typeof fetch = fetch): Promise<string> {
  const failures: CliReleaseNoticeFailure[] = [];
  for (let attempt = 1; ; attempt++) {
    const started = Date.now(), signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let phase: CliReleaseNoticeEvidence["phase"] = "feed_headers", status = 0;
    try {
      const response = await fetcher(CLI_RELEASE_FEEDS[channel], { headers: { accept: "application/json" }, signal });
      status = response.status;
      phase = "feed_contract";
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(`CLI ${channel} release feed answered ${status}`);
      }
      phase = "feed_body";
      const bytes = await readBoundedStream(response.body, MAX_BODY_BYTES,
        () => new Error(`CLI ${channel} release feed is too large`), signal);
      phase = "feed_contract";
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown } | null;
      if (typeof body?.version !== "string" || cliReleaseChannelOf(body.version) !== channel) {
        throw new Error(`CLI ${channel} release feed names no ${channel} release`);
      }
      return body.version;
    } catch (cause) {
      failures.push(new CliReleaseNoticeFailure(cause, channel, phase, started, status, attempt));
      // Only a read's transport failure is replayable. Contract failures and
      // any subsequent owner read or socket delivery keep their own boundary.
      const transport = (phase === "feed_headers" || phase === "feed_body") &&
        (signal.aborted || cause instanceof TypeError ||
          (cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name)));
      if (attempt >= 2 || !transport) throw new AggregateError(failures, `CLI ${channel} release feed failed`);
    }
  }
}

type CellFetcher = { fetch(request: Request): Promise<Response> };

export interface CliReleaseNoticeDependencies {
  latest?: (channel: CliReleaseChannel) => Promise<string>;
  owners?: (notice: MachineDaemonCliReleaseNotice) => Promise<string[]>;
  cells?: (ownerUserIds: readonly string[]) => CellFetcher[];
}

/**
 * Pushes each channel's newest CLI release to the daemons still behind it.
 * The daemon holds no clock of its own: it updates when told. Every pass
 * reads both channel feeds, finds the owners with an online daemon on that
 * channel reporting another version, and asks those owners' Runtime cells to
 * send the notice to the sockets that are actually behind. A daemon that
 * missed a notice (it was reconnecting, or its update failed) is told again
 * on the next pass until it reconnects on the new version.
 */
export async function noticeCliReleases(env: Env, dependencies: CliReleaseNoticeDependencies = {}):
  Promise<{ told: number }> {
  const database = dependencies.owners ? undefined
    : postgresAuthorityDatabase(env, "Machine", "xmatrix-hub-cli-release").openSession();
  const owners = dependencies.owners ?? (notice => readCliReleaseOwners(database!,
    { requestId: `cli-release:${crypto.randomUUID()}`, channel: notice.channel, version: notice.version }));
  const cells = dependencies.cells ?? (ownerUserIds => relayRuntimeCellsForOwners(env, ownerUserIds));
  const latest = dependencies.latest ?? (channel => fetchCliChannelVersion(channel));
  const failures: unknown[] = [];
  let told = 0;
  try {
    for (const channel of ["stable", "dev"] as const) {
      const started = Date.now();
      let phase: CliReleaseNoticeEvidence["phase"] = "feed_read";
      try {
        const notice: MachineDaemonCliReleaseNotice = { type: "machine_cli_release", channel,
          version: await latest(channel) };
        phase = "owner_read";
        const behind = await owners(notice);
        if (behind.length === 0) continue;
        phase = "cell_fetch";
        const answers = await Promise.allSettled(cells(behind).map(cell => tellCell(env, cell, notice)));
        for (const answer of answers) {
          if (answer.status === "rejected") failures.push(answer.reason);
          else if (typeof answer.value === "number") told += answer.value;
        }
      } catch (error) {
        failures.push(cliReleaseNoticeEvidence(error).length > 0
          ? error : new CliReleaseNoticeFailure(error, channel, phase, started));
      }
    }
  } finally {
    await database?.close();
  }
  if (failures.length > 0) throw new AggregateError(failures, "CLI release notice failed");
  return { told };
}

/** How many sockets one cell told; `undefined` for a cell still on an earlier release. */
async function tellCell(env: Env, cell: CellFetcher, notice: MachineDaemonCliReleaseNotice):
  Promise<number | undefined> {
  const started = Date.now();
  let phase: CliReleaseNoticeEvidence["phase"] = "cell_fetch", status = 0;
  try {
    const response = await cell.fetch(new Request(`https://relay-runtime${RELAY_RUNTIME_CLI_RELEASE_NOTICE_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(notice) }));
    status = response.status;
    phase = "cell_body";
    const body = await response.json<Record<string, unknown>>();
    phase = "cell_contract";
    if (response.ok && typeof body.told === "number") return body.told;
    // A deploy reaches this Worker before each cell restarts on it: a cell on
    // an earlier release has no such route yet and is told on a later pass.
    if (response.status === 404 && typeof body.workerVersion === "string" &&
        body.workerVersion !== analyticsWorkerVersion(env)) return undefined;
    throw new Error(`CLI release notice cell answered ${status}`);
  } catch (cause) {
    throw new CliReleaseNoticeFailure(cause, notice.channel, phase, started, status);
  }
}

/** The Runtime cell's side: a notice it can trust, or `undefined`. */
export function parseCliReleaseNotice(value: unknown): MachineDaemonCliReleaseNotice | undefined {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const { channel, version } = record;
  if (record.type !== "machine_cli_release" || (channel !== "stable" && channel !== "dev") ||
      typeof version !== "string" || version.length > 64 || cliReleaseChannelOf(version) !== channel) return undefined;
  return { type: "machine_cli_release", channel, version };
}
