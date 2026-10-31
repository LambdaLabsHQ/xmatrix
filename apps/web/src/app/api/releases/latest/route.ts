import { NextResponse } from "next/server";

import {
  fetchDevRelease,
  fetchLatestStableAndroidRelease,
  fetchLatestStableCliRelease,
  fetchLatestStableDesktopMacRelease,
  getLatestReleaseManifest,
  releaseVersionFromTag,
} from "@/lib/github-release";

const RELEASE_TARGETS = {
  cli: {
    resolveRelease: fetchLatestStableCliRelease,
    downloadBasePath: "/api/cli/releases/latest",
  },
  desktop: {
    resolveRelease: fetchLatestStableDesktopMacRelease,
    downloadBasePath: "/api/desktop/releases",
  },
  android: {
    resolveRelease: fetchLatestStableAndroidRelease,
    downloadBasePath: "/api/android/releases/stable",
  },
} as const;

const DEV_COMPONENTS = ["cli", "desktop"] as const;

export async function GET(request: Request) {
  try {
    const origin = new URL(request.url).origin;
    const entries = await Promise.all(
      Object.entries(RELEASE_TARGETS).map(async ([target, config]) => {
        const release = await config.resolveRelease();
        return [
          target,
          getLatestReleaseManifest(release, origin, config.downloadBasePath),
        ] as const;
      })
    );

    // A beta build follows the dev channel, so it is judged against that
    // channel's newest beta. A component with no dev release is left out.
    const devEntries = await Promise.all(
      DEV_COMPONENTS.map(async (component) => {
        try {
          return [component, { version: releaseVersionFromTag((await fetchDevRelease(component)).tag_name) }] as const;
        } catch {
          return null;
        }
      })
    );

    return NextResponse.json(
      {
        version: entries[0]?.[1].trainVersion,
        trainVersion: entries[0]?.[1].trainVersion,
        releases: Object.fromEntries(entries),
        devReleases: Object.fromEntries(devEntries.filter((entry) => entry !== null)),
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      }
    );
  } catch {
    return NextResponse.json(
      { error: "xMatrix releases are unavailable right now." },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
