/**
 * The single `@agent:new|once[!][:<workspace>]` and
 * `@agent:<n>:handoff:@<successor>` mention grammar.
 *
 * Composer completion and the Hub's authoritative parse must accept exactly the
 * same text. When each side kept its own copy they drifted: the composer never
 * recognised `:once` or the `!` parallel override, and a mention written inside
 * brackets parsed on the Hub while the composer treated it as ordinary text.
 * Every surface that reads or writes this grammar imports from here.
 */

import { interactionMentionScanner } from "./message-interaction-grammar.js";
import { agentPresetForLauncher } from "./agent-presets.js";
/** Raw fragment so surfaces that embed the name in a larger pattern share this definition. */
export const AGENT_NAME_SOURCE = "[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}";
export const AGENT_NAME_PATTERN = new RegExp(`^${AGENT_NAME_SOURCE}$`, "u");
export const REPO_OWNER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** A mention opens at the start of a message or after whitespace or an opening bracket. */
const MENTION_OPEN = "(?:^|[\\s([{])";
/** Lazy so the shortest name that still reaches a start action wins. */
const MENTION_TARGET = "[^\\s\\]})]+?";
const CREATE_ACTION = ":(?:new|once)!?";
/**
 * Whitespace, a closing bracket, or sentence punctuation closes a mention. ASCII
 * sentence separators stay out: they occur inside Windows paths and dotted names.
 * Full-width punctuation (the separator a CJK sentence actually uses) ends the
 * mention so `@agent:new:owner/repo，继续` does not absorb the following prose.
 */
const MENTION_TERMINATOR = "\\s\\]})，。！？；、）】》」』";
/** A quoted tail carries a path containing whitespace; a doubled quote is one literal quote. */
const WORKSPACE_TAIL = `(?::(?:"(?:[^"]|"")*"|[^${MENTION_TERMINATOR}]+))?`;
/** A mention closes at end of message or before whitespace, a bracket, or sentence punctuation. */
const MENTION_CLOSE = `(?=[${MENTION_TERMINATOR}]|$)`;
const REBORN_TAIL = ":[1-9]\\d*:reborn";
const HANDOFF_TAIL = ":[1-9]\\d*:handoff:[@＠][^\\s\\]})]+";
const INVOCATION_TAIL_PATTERNS = [`${CREATE_ACTION}${WORKSPACE_TAIL}`, REBORN_TAIL, HANDOFF_TAIL]
  .map(source => new RegExp(`^${source}${MENTION_CLOSE}`, "iu"));

/** Preserve complete lifecycle tails, including quoted paths and dotted names. */
export function agentInvocationTailLength(tail: string): number | undefined {
  for (const pattern of INVOCATION_TAIL_PATTERNS) {
    const match = pattern.exec(tail);
    if (match) return match[0].length;
  }
  return undefined;
}

/**
 * Fresh global scanner over a whole message body, capturing the `@`-less target.
 * Returns a new RegExp per call because `lastIndex` on a shared `/g` instance
 * makes repeated scans of different bodies skip matches.
 */
export function createInstanceMentionScanner(): RegExp {
  return new RegExp(
    `${MENTION_OPEN}[@＠](${MENTION_TARGET}${CREATE_ACTION}${WORKSPACE_TAIL})${MENTION_CLOSE}`,
    "giu",
  );
}

export function rebornInstanceMentionScanner(): RegExp {
  return interactionMentionScanner("lifecycle.reborn.v1");
}

/** Existing-instance addresses; selecting them for status reads performs no action. */
export function existingInstanceMentionScanner(): RegExp {
  return new RegExp(`${MENTION_OPEN}[@＠](${AGENT_NAME_SOURCE}:[1-9]\\d*)(?=[\\s\\]}).,!?;，。！？；]|$)`, "giu");
}

/** Bare `@codex` is an abstract capability shout. Instance ordinals and
 * `:new`/`:once`/`:reborn`/`:handoff` keep their existing grammar. */
export function parseHarnessCapabilityMentions(body: string): Array<{
  harness: string; start: number; end: number; text: string;
}> {
  const mentions: Array<{ harness: string; start: number; end: number; text: string }> = [];
  const scanner = new RegExp(`${MENTION_OPEN}([@＠])([a-zA-Z][a-zA-Z0-9_-]{0,79})(?=[\\s\\]})]|$)`, "gu");
  for (const match of body.matchAll(scanner)) {
    const at = match[1]!;
    const name = match[2]!;
    const start = (match.index ?? 0) + match[0].indexOf(at);
    const end = start + at.length + name.length;
    const tail = body.slice(end);
    if (/^:(?:[1-9]\d*|new|once|handoff|reborn)\b/iu.test(tail)) continue;
    const preset = agentPresetForLauncher(name);
    if (!preset) continue;
    mentions.push({ harness: preset.id, start, end, text: `${at}${name}` });
  }
  return mentions;
}

/**
 * `@agent:new:<path>` is machine-routed, so only an absolute path can identify
 * the registered directory together with that machine. Relative paths and
 * home-directory shorthand depend on daemon process state and are not summon
 * identities.
 */
export function isAbsoluteLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(trimmed) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/u.test(trimmed);
}

/** Local checkouts are working-dir launches, never repository summon references. */
function isLocalFilesystemReference(value: string): boolean {
  if (value.startsWith("file:")) return true;
  if (value.startsWith("./") || value.startsWith("../") || value === "." || value === "..") {
    return true;
  }
  if (value.startsWith("/") || value.startsWith("~")) return true;
  // Windows absolute paths: C:\..., C:/..., \\server\share, \\?\C:\...
  if (/^[a-zA-Z]:[\\/]/u.test(value)) return true;
  if (value.startsWith("\\\\") || value.startsWith("//")) return true;
  return false;
}

/**
 * The canonical reference a repo summon carries, normalised from a git remote or
 * from what a human typed after `:new:`. Both directions must agree, so this is
 * the only definition:
 * - never emits credentials, query, or fragment into channel-visible text
 * - GitHub remotes collapse to `owner/repo` (the daemon reads that as GitHub)
 * - non-GitHub remotes keep a sanitized cloneable HTTPS/SSH URL
 * - bare `owner/repo` is accepted as typed
 * - local filesystem references and unparseable values yield no repo reference
 *
 * The daemon canonicalises further when it keys its repo pool, so alternate
 * spellings of one repository still resolve to a single local clone.
 */
export function repoSummonReference(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /\s/u.test(trimmed)) return undefined;
  if (isLocalFilesystemReference(trimmed)) return undefined;

  // scp-like: [user@]host:owner/repo(.git) — never password-bearing.
  const scp = trimmed.match(/^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+):([^/][^:\s]*)$/u);
  if (scp) {
    const user = scp[1] || "";
    const host = scp[2]!;
    const pathPart = scp[3]!.replace(/\.git$/iu, "").replace(/\/+$/u, "");
    if (!pathPart || /[@?#]/u.test(pathPart)) return undefined;
    // A remote reads as scp only with an owner/repo path and a recognisable
    // host. Without this, opaque `word:word` text such as `workspace:8ee40ca9`
    // would pass as a repository instead of being rejected as invalid.
    if (!pathPart.includes("/") || (!user && !host.includes("."))) return undefined;
    if (/^github\.com$/iu.test(host)) {
      const segments = pathPart.split("/").filter(Boolean);
      if (segments.length >= 2) return `${segments[0]}/${segments[1]}`;
      return undefined;
    }
    return `${user}${host}:${pathPart}`;
  }

  // URL forms: http(s):// and ssh://
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol !== "http:" && protocol !== "https:" && protocol !== "ssh:") {
        return undefined;
      }
      // Capture a safe username before clearing credentials (ssh only; never password).
      const safeUser =
        protocol === "ssh:" && parsed.username && !parsed.password && !parsed.username.includes(":")
          ? `${parsed.username}@`
          : "";
      // Strip credentials, query, and fragment before any product surface sees them.
      const host = parsed.hostname.toLowerCase();
      if (!host) return undefined;
      const port = parsed.port ? `:${parsed.port}` : "";
      const pathPart = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
      const segments = pathPart.split("/").filter(Boolean);
      if (segments.length < 2) return undefined;

      if (host === "github.com" || host === "www.github.com") {
        return `${segments[0]}/${segments[1]}`;
      }
      if (protocol === "ssh:") {
        return `ssh://${safeUser}${host}${port}/${segments.join("/")}`;
      }
      // http(s): never re-emit username/password/query/fragment.
      return `${protocol}//${host}${port}/${segments.join("/")}`;
    } catch {
      return undefined;
    }
  }

  // Bare `owner/repo` shorthand.
  const segments = trimmed
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  if (segments.length === 2 && segments.every((segment) => REPO_OWNER_NAME_PATTERN.test(segment))) {
    return segments.join("/");
  }
  return undefined;
}

/**
 * The GitHub repository a reference names, in the one spelling GitHub's API
 * uses. `repoSummonReference` normalizes every GitHub remote to bare
 * `owner/repo` and leaves every other code host carrying its scheme or host, so
 * a two-segment result is exactly the GitHub case.
 *
 * This is the only place that decides "is this a GitHub repository reference":
 * the Space's launch targets, the machine's repository-token mint, and the
 * composer all read the same answer.
 */
export function githubRepositoryReference(
  value: string,
): { owner: string; repo: string } | undefined {
  const reference = repoSummonReference(value);
  if (!reference) return undefined;
  const segments = reference.split("/");
  if (segments.length !== 2) return undefined;
  const [owner, repo] = segments as [string, string];
  if (!REPO_OWNER_NAME_PATTERN.test(owner) || !REPO_OWNER_NAME_PATTERN.test(repo)) {
    return undefined;
  }
  return { owner, repo };
}

export interface ParsedHandoffInstanceMention {
  /** Original `@`-less target text including `:<ordinal>:handoff:@<successor>`. */
  target: string;
  sourceAgentName: string;
  channelInstanceId: number;
  successorName: string;
}

/**
 * A successor Agent name cannot be an instance address. Agent names may
 * contain `:`, but `@<name>:<n>` is existing-to-existing and is rejected.
 */
export function isHandoffSuccessorName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || !AGENT_NAME_PATTERN.test(trimmed)) return false;
  if (trimmed.toLowerCase() === "xmatrix") return false;
  return !/:[1-9]\d*$/u.test(trimmed);
}

/** `handoff:@auto`: xMatrix picks the successor, on any machine. */
export function isAutoHandoffSuccessor(value: string): boolean {
  return value.trim().toLowerCase() === "auto";
}

/**
 * Parse `@<existing>:<n>:handoff:@<successor>` from the `@`-less target.
 * Incomplete forms (`:handoff` with no successor) and destination ordinals
 * return null so Hub and the composer reject the same spellings.
 */
export function parseHandoffInstanceTarget(raw: string): ParsedHandoffInstanceMention | null {
  const normalized = raw.trim();
  const parsed = /^(.*):([1-9]\d*):handoff:([@＠])(.+)$/iu.exec(normalized);
  if (!parsed) return null;
  const sourceAgentName = parsed[1]!.trim();
  const channelInstanceId = Number(parsed[2]);
  const successorName = parsed[4]!.trim();
  if (!AGENT_NAME_PATTERN.test(sourceAgentName) || sourceAgentName.toLowerCase() === "xmatrix") {
    return null;
  }
  if (!Number.isSafeInteger(channelInstanceId)) return null;
  if (!isHandoffSuccessorName(successorName)) return null;
  return {
    target: normalized,
    sourceAgentName,
    channelInstanceId,
    successorName,
  };
}

/**
 * Fresh global scanner over a whole message body, capturing the `@`-less
 * handoff target. A new RegExp per call so `lastIndex` cannot skip bodies.
 */
export function handoffInstanceMentionScanner(): RegExp {
  return interactionMentionScanner("lifecycle.handoff.v1");
}

/**
 * A handoff mention ending at the caret. Capture group 1 is the source
 * ordinal, group 2 is the successor text typed so far (without a leading `@`).
 * The successor group is `""` for a trailing `:handoff:` or `:handoff:@`.
 */
export const HANDOFF_INSTANCE_MENTION_AT_CARET_RE = new RegExp(
  `[@＠]${MENTION_TARGET}:([1-9]\\d*):handoff:(?:[@＠]([^\\s\\]})]*))?$`,
  "u",
);
