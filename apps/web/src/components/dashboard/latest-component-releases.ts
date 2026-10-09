"use client";
import { useQuery } from "@tanstack/react-query";

import { xmatrixApiRequest } from "@/lib/query/api-client";

/* A release train publishes only the components it selects, so web/hub, the CLI
   (which is also the daemon) and the desktop app each carry their own newest
   version. A machine's component is current when it matches that component's
   stable channel, not the web/hub version this page was built at. */
export type ReleaseComponent = "cli" | "desktop";

type LatestReleasesResponse = { releases?: Partial<Record<ReleaseComponent, { version?: unknown }>> };

// A page left open picks up a release published since once the answer is this old.
const LATEST_RELEASES_STALE_MS = 10 * 60_000;

export function useLatestComponentRelease(component: ReleaseComponent): string | undefined {
  const latest = useQuery({
    queryKey: ["releases", "latest"],
    staleTime: LATEST_RELEASES_STALE_MS,
    queryFn: ({ signal }) => xmatrixApiRequest<LatestReleasesResponse>({ url: "/api/releases/latest", signal }),
  });
  const version = latest.data?.releases?.[component]?.version;
  return typeof version === "string" && version ? version : undefined;
}
