import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertSemver, compareSemver, RELEASE_TAG_PATTERN, releaseChannel } from "./release-version-order.mjs";

const NOTES_MARKER = "<!-- xmatrix-release-notes:v1 -->";

/** Stable notes belong to the candidate's immutable source, never newer main. */
export function authoredReleaseNotes(root, version, revision) {
  assertSemver(version);
  const file = `docs/releases/${version}.md`;
  let text;
  try {
    text = revision
      ? execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      : readFileSync(path.join(root, file), "utf8");
  } catch {
    throw new Error(`Missing release notes: ${file}. The stable release Agent must write them, merge, and verify a beta containing them before requesting stable.`);
  }
  text = text.replace(/\r\n/gu, "\n");
  const heading = `# xMatrix ${version}`;
  const body = text.trim().slice(heading.length).trim();
  if (!text.trim().startsWith(`${heading}\n`) || !body || Buffer.byteLength(text) > 32_768 || /<!--\s*xmatrix-release-/u.test(text)) {
    throw new Error(`${file} must start with '${heading}', contain user-facing changes, fit 32 KiB and contain no release control markers`);
  }
  return body;
}

const RATE_LIMIT_DELAY_CAP_MS = 60_000;
const RELEASE_NOTES_ATTEMPTS = 4;

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? null;
}

/**
 * How long to wait before repeating a refused GitHub read, or null when the
 * refusal is final. GitHub throttles with 429, or with 403 carrying rate-limit
 * evidence (primary: remaining 0 and reset; secondary: Retry-After or a rate
 * limit message). A 403 without that evidence is a permission refusal, so
 * retrying it would only delay the failure.
 */
export function githubRetryDelayMs(response, body, attempt) {
  if (!response) return Math.min(RATE_LIMIT_DELAY_CAP_MS, 1_000 * 2 ** attempt);
  const retryAfter = Number(responseHeader(response, "retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(RATE_LIMIT_DELAY_CAP_MS, retryAfter * 1_000);
  }
  if (response.status === 429 || response.status >= 500) {
    return Math.min(RATE_LIMIT_DELAY_CAP_MS, 1_000 * 2 ** attempt);
  }
  if (response.status !== 403) return null;
  const reset = Number(responseHeader(response, "x-ratelimit-reset"));
  if (responseHeader(response, "x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
    return Math.max(1_000, Math.min(RATE_LIMIT_DELAY_CAP_MS, reset * 1_000 - Date.now()));
  }
  if (/rate limit|secondary rate|abuse/iu.test(body ?? "")) {
    return Math.min(RATE_LIMIT_DELAY_CAP_MS, 1_000 * 2 ** attempt);
  }
  return null;
}

export async function generatedBetaReleaseNotes({
  repository, tag, token, attempts = RELEASE_NOTES_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const version = tag.replace(/^xmatrix-v/u, "");
  assertSemver(version);
  const api = async (suffix, body) => {
    for (let attempt = 0; ; attempt++) {
      let response;
      let text = "";
      try {
        const url = new URL(`https://api.github.com/repos/${repository}/releases${suffix}`);
        if (!body) url.searchParams.set("_xmatrix_read", randomUUID());
        response = await fetch(url.toString(), {
          method: body ? "POST" : "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "Cache-Control": "no-cache" },
          cache: "no-store",
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) return await response.json();
        text = await response.text().catch(() => "");
      } catch (error) {
        if (error instanceof SyntaxError) throw error;
        if (attempt + 1 >= attempts) throw error;
        await sleep(githubRetryDelayMs(undefined, "", attempt));
        continue;
      }
      const delay = attempt + 1 >= attempts ? null : githubRetryDelayMs(response, text, attempt);
      if (delay === null) {
        const detail = text.trim().slice(0, 300);
        throw new Error(`Reading release notes failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      await sleep(delay);
    }
  };
  // GitHub's implicit baseline can start at the first public commit when tags
  // are stamped siblings. Name the preceding published version explicitly.
  const releases = await api("?per_page=100");
  const previous = releases.filter((release) => !release.draft && RELEASE_TAG_PATTERN.test(release.tag_name) &&
    compareSemver(release.tag_name.slice("xmatrix-v".length), version) < 0)
    .sort((left, right) => compareSemver(right.tag_name.slice("xmatrix-v".length), left.tag_name.slice("xmatrix-v".length)))[0];
  if (!previous && releases.length) throw new Error(`No published release baseline found before ${tag}`);
  const generated = await api("/generate-notes", { tag_name: tag, ...(previous ? { previous_tag_name: previous.tag_name } : {}) });
  return generated.body;
}

export function composeReleaseNotes({ notes, receipt }) {
  if (!notes?.trim() || notes.length > 100_000 || /<!--\s*xmatrix-release-/u.test(notes)) {
    throw new Error("Release notes must contain bounded text without release control markers");
  }
  return `${NOTES_MARKER}\n${notes.trim()}\n\n## Deployment receipt\n\n${receipt.trim()}`;
}

/** Apple normalizes LF to CRLF when checking the 4,000-character What's New limit. */
export function appleTextLength(text) {
  return [...text].length + (text.match(/\n/gu)?.length ?? 0);
}

/**
 * App Store "What's New" is plain text: Apple refuses the whole version write
 * with HTTP 409 when it sees anything shaped like markup, such as `<words>` in
 * a command example. Headings, emphasis, code spans and links become their
 * text, and angle brackets become single guillemets.
 */
export function plainStoreText(markdown) {
  return markdown
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/gu, "$1 ($2)")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/</gu, "‹")
    .replace(/>/gu, "›");
}

/** Apple's What's New field is plain text, bounded to 4,000 CRLF characters. */
export function appStoreReleaseNotes(root, version) {
  const notes = plainStoreText(authoredReleaseNotes(root, version));
  const link = `\n\nFull release notes: https://xmatrix.sh/releases/${version}`;
  const available = 4_000 - appleTextLength(link);
  if (appleTextLength(notes) <= available) return notes + link;
  let used = 0;
  let out = "";
  for (const ch of notes) {
    const cost = ch === "\n" ? 2 : 1;
    if (used + cost > available - 1) break;
    out += ch;
    used += cost;
  }
  return `${out}…${link}`;
}

async function publish(root) {
  const version = process.env.RELEASE_TAG?.replace(/^xmatrix-v/u, "");
  assertSemver(version);
  let notes;
  if (releaseChannel(version) === "stable") {
    notes = authoredReleaseNotes(root, version);
  } else {
    // Beta notes describe the exact tag's merged PRs; stable gets an authored
    // summary of the user-visible changes since the previous stable instead.
    notes = await generatedBetaReleaseNotes({ repository: process.env.GITHUB_REPOSITORY,
      tag: process.env.RELEASE_TAG, token: process.env.GITHUB_TOKEN });
  }
  process.env.RELEASE_NOTES = composeReleaseNotes({ notes, receipt: process.env.RELEASE_NOTES });
  await import("./publish-github-release.mjs");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publish(path.resolve(fileURLToPath(new URL("..", import.meta.url))));
}
