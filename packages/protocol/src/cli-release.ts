/**
 * Which CLI release channel a version follows and whether a newer release of
 * that channel supersedes it. A stable `X.Y.Z` follows `stable`; a beta
 * `X.Y.Z-beta.N` follows `dev`. Build metadata (`+…`) is ignored.
 */
import type { CliReleaseChannel } from "./connections/machine-daemon.js";

const RELEASE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/u;

function parse(version: string): { core: [number, number, number]; beta?: number } | undefined {
  const match = RELEASE_VERSION.exec(version.trim().split("+", 1)[0] ?? "");
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] === undefined ? {} : { beta: Number(match[4]) }),
  };
}

/** The channel a CLI of `version` follows, or `undefined` for a version no channel publishes. */
export function cliReleaseChannelOf(version: string): CliReleaseChannel | undefined {
  const parsed = parse(version);
  if (!parsed) return undefined;
  return parsed.beta === undefined ? "stable" : "dev";
}

/**
 * Whether `latest`, the newest release of a channel, supersedes a CLI running
 * `current` on that same channel. A version of another channel, or one no
 * channel publishes, is never superseded by it.
 */
export function cliReleaseSupersedes(latest: string, current: string): boolean {
  const next = parse(latest);
  const running = parse(current);
  if (!next || !running || (next.beta === undefined) !== (running.beta === undefined)) return false;
  for (let index = 0; index < 3; index += 1) {
    const delta = next.core[index]! - running.core[index]!;
    if (delta !== 0) return delta > 0;
  }
  return (next.beta ?? 0) > (running.beta ?? 0);
}
