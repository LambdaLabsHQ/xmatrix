"use client";
import { useQuery } from "@tanstack/react-query";

import { xmatrixApiRequest } from "@/lib/query/api-client";

/* A release train publishes only the components it selects, so web/hub, the CLI
   (which is also the daemon) and the desktop app each carry their own newest
   version. A build follows only the channel it was published to: a stable
   `X.Y.Z` the stable channel, a beta `X.Y.Z-beta.N` the dev channel. A
   machine's component is current when it matches the newest release of its own
   channel, not the web/hub version this page was built at. */
export type ReleaseComponent = "cli" | "desktop";

type ComponentReleases = Partial<Record<ReleaseComponent, { version?: unknown; publishedAt?: unknown }>>;
export type LatestRelease = { version: string; publishedAt?: string };
type LatestReleasesResponse = { releases?: ComponentReleases; devReleases?: ComponentReleases };

// A page left open picks up a release published since once the answer is this old.
const LATEST_RELEASES_STALE_MS = 10 * 60_000;

function isBetaVersion(version: string): boolean {
  return (version.trim().split("+", 1)[0] ?? "").includes("-");
}

/** The newest release of `component` on the channel a build of `version` follows. */
export function useLatestComponentRelease(component: ReleaseComponent, version?: string, enabled = true): LatestRelease | undefined {
  const latest = useQuery({
    enabled,
    queryKey: ["releases", "latest"],
    staleTime: LATEST_RELEASES_STALE_MS,
    queryFn: ({ signal }) => xmatrixApiRequest<LatestReleasesResponse>({ url: "/api/releases/latest", signal }),
  });
  const channel = version && isBetaVersion(version) ? latest.data?.devReleases : latest.data?.releases;
  const newest = channel?.[component];
  if (typeof newest?.version !== "string" || !newest.version) return undefined;
  return {
    version: newest.version,
    ...(typeof newest.publishedAt === "string" ? { publishedAt: newest.publishedAt } : {}),
  };
}
