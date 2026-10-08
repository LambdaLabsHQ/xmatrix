/* The channel rail edits a GitHub subscription by posting the same connector
   command a human would type, so these builders are the whole write contract
   between the panel and the Hub's `@github:subscribe:` handler. They are kept
   apart from the component so a test can run them rather than read them. */

import {
  GITHUB_REPOSITORY_FEATURES,
  type GitHubRepositoryFeature,
} from "@xmatrix/protocol";

export interface ChannelConnectorCommand {
  /** `github:repo:owner/name`, the subscription source the command edits. */
  source: string;
  body: string;
}

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/* What a row names: `owner/repo` for a repository, `owner/repo#7` for the
   pull request a Run opened here. */
export function githubSubscriptionRepository(source: string): string {
  return source.replace(/^github:(?:repo|issue):/iu, "");
}

export function githubSubscriptionSource(repository: string): string {
  return `github:repo:${repository}`.toLowerCase();
}

export function isGitHubRepositoryName(value: string): boolean {
  return REPOSITORY_NAME.test(value.trim());
}

/* The Hub stores an unordered feature set; presenting it in manifest order keeps
   a row from reshuffling every time one feature is added. */
export function githubSubscriptionFeatures(
  features: readonly string[],
): GitHubRepositoryFeature[] {
  return GITHUB_REPOSITORY_FEATURES.filter((feature) => features.includes(feature));
}

export function githubToggledFeatures(
  current: readonly GitHubRepositoryFeature[],
  feature: GitHubRepositoryFeature,
): GitHubRepositoryFeature[] {
  return current.includes(feature)
    ? current.filter((value) => value !== feature)
    : GITHUB_REPOSITORY_FEATURES.filter((value) => value === feature || current.includes(value));
}

/* The panel edits the whole event set at once, and `subscribe` adds while
   `unsubscribe` subtracts — so a draft that turns one event on and another off
   is two statements. They travel as two lines of one message: the human made a
   single decision and the channel should show a single command.

   The features the draft leaves untouched are never named. An edit says what it
   changes, so reading the channel back tells you what the human actually did. */
export function githubFeatureCommand(
  repository: string,
  current: readonly GitHubRepositoryFeature[],
  next: readonly GitHubRepositoryFeature[],
): ChannelConnectorCommand | undefined {
  const name = repository.trim();
  if (!isGitHubRepositoryName(name)) return undefined;
  const added = next.filter((feature) => !current.includes(feature));
  const removed = current.filter((feature) => !next.includes(feature));
  const statements = [
    ...(added.length > 0 ? [`@github:subscribe:${name} ${added.join(" ")}`] : []),
    ...(removed.length > 0 ? [`@github:unsubscribe:${name} ${removed.join(" ")}`] : []),
  ];
  if (statements.length === 0) return undefined;
  return { source: githubSubscriptionSource(name), body: statements.join("\n") };
}

export function githubSubscribeCommand(
  repository: string,
  features: readonly GitHubRepositoryFeature[],
): ChannelConnectorCommand | undefined {
  if (features.length === 0) return undefined;
  return githubFeatureCommand(repository, [], features);
}

/** Drop the repository from this channel outright, whatever it is subscribed to. */
export function githubUnsubscribeCommand(
  repository: string,
): ChannelConnectorCommand | undefined {
  if (!isGitHubRepositoryName(repository)) return undefined;
  return {
    source: githubSubscriptionSource(repository.trim()),
    body: `@github:unsubscribe:${repository.trim()} all`,
  };
}
