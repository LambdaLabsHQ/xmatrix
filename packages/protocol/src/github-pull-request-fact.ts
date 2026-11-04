/**
 * A fact GitHub reported about a subscribed pull request: its CI verdict, its
 * merge or its close (docs/design/conversation-activity.md §3.6, §4.1). The
 * Hub writes it beside the message text, so a timeline draws it as the same
 * compact line as the "Opened" entry before it, and people's reviews and
 * comments stay whole messages. Only the Hub writes `xmatrix*` metadata.
 */

export const GITHUB_PULL_REQUEST_FACT_METADATA_KEY = "xmatrixGitHubPullRequest";

export interface GitHubPullRequestFactCheck {
  name: string;
  url?: string;
}

export type GitHubPullRequestFact = {
  /** `owner/name`. */
  repository: string;
  number: number;
  url: string;
} & (
  | { event: "ci_passed"; sha: string }
  | { event: "ci_failed"; sha: string; failed: GitHubPullRequestFactCheck[]; more: number }
  /** `actor` is the person who merged or closed it; a GitHub App's bot is not named. */
  | { event: "merged" | "closed"; title: string; actor?: string }
);

const GITHUB_URL = /^https:\/\/github\.com\//u;
/** A check may link to another CI service's page. */
const HTTPS_URL = /^https:\/\//u;

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The fact a message's metadata carries, or undefined when it carries none or a malformed one. */
export function githubPullRequestFactOf(metadata: unknown): GitHubPullRequestFact | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[GITHUB_PULL_REQUEST_FACT_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fact = value as Record<string, unknown>;
  const repository = string(fact.repository);
  const url = string(fact.url);
  const number = fact.number;
  if (!repository || !url || !GITHUB_URL.test(url) || typeof number !== "number" || !Number.isSafeInteger(number)) {
    return undefined;
  }
  const ref = { repository, number, url };
  const sha = string(fact.sha) ?? "";
  if (fact.event === "ci_passed") return { ...ref, event: "ci_passed", sha };
  if (fact.event === "ci_failed") {
    const failed = (Array.isArray(fact.failed) ? fact.failed : []).flatMap((entry): GitHubPullRequestFactCheck[] => {
      const check = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const name = string(check.name);
      const checkUrl = string(check.url);
      if (!name) return [];
      return [{ name, ...(checkUrl && HTTPS_URL.test(checkUrl) ? { url: checkUrl } : {}) }];
    });
    const more = typeof fact.more === "number" && Number.isSafeInteger(fact.more) && fact.more > 0 ? fact.more : 0;
    return { ...ref, event: "ci_failed", sha, failed, more };
  }
  if (fact.event === "merged" || fact.event === "closed") {
    const actor = string(fact.actor);
    return { ...ref, event: fact.event, title: string(fact.title) ?? "", ...(actor ? { actor } : {}) };
  }
  return undefined;
}
