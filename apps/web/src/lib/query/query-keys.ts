import { xmatrixHubOrigin } from "./api-client";

export interface QueryIdentity {
  userId: string;
  hubOrigin?: string;
}

function identity(input: QueryIdentity): readonly [string, string] {
  return [input.hubOrigin || xmatrixHubOrigin(), input.userId] as const;
}

export const xmatrixQueryKeys = {
  all: (input: QueryIdentity) => ["xmatrix", ...identity(input)] as const,
  channels: (input: QueryIdentity & { spaceId: string }) =>
    [...xmatrixQueryKeys.all(input), "channels", input.spaceId] as const,
  channelCatalog: (input: QueryIdentity & {
    spaceId: string;
    view: string;
    filter: string;
    scopeChannelId: string | null;
    query: string;
  }) => [...xmatrixQueryKeys.channels(input), "catalog", input.view, input.filter,
    input.scopeChannelId, input.query] as const,
  channelCatalogCounts: (input: QueryIdentity & { spaceId: string }) =>
    [...xmatrixQueryKeys.channels(input), "catalog-counts"] as const,
  channelResolve: (input: QueryIdentity & {
    spaceId: string;
    channelIds: readonly string[];
    routeToken?: string | null;
    includeParticipants?: boolean;
  }) => [...xmatrixQueryKeys.channels(input), "resolve",
    [...input.channelIds].sort(), input.routeToken ?? null, input.includeParticipants !== false] as const,
  channelEntities: (input: QueryIdentity & { spaceId: string }) =>
    [...xmatrixQueryKeys.channels(input), "entities"] as const,
  preference: (input: QueryIdentity & { spaceId: string }) =>
    [...xmatrixQueryKeys.all(input), "preference", input.spaceId] as const,
  focusAttempt: (input: QueryIdentity & { spaceId: string }) =>
    [...xmatrixQueryKeys.all(input), "focus-attempt", input.spaceId] as const,
  focusRun: (input: QueryIdentity & { spaceId: string; runId: string }) =>
    [...xmatrixQueryKeys.all(input), "focus-run", input.spaceId, input.runId] as const,
  spaces: (input: QueryIdentity) => [...xmatrixQueryKeys.all(input), "spaces"] as const,
  projectionReadiness: (input: QueryIdentity) =>
    [...xmatrixQueryKeys.all(input), "projection-readiness"] as const,
  domain: (input: QueryIdentity, domain: string, scope: readonly unknown[] = []) =>
    [...xmatrixQueryKeys.all(input), domain, ...scope] as const,
};
