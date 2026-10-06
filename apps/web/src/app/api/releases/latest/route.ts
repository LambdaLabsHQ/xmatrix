import { NextResponse } from "next/server";

import {
  fetchLatestStableAndroidRelease,
  fetchLatestStableCliRelease,
  fetchLatestStableDesktopMacRelease,
  getLatestReleaseManifest,
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

    return NextResponse.json(
      {
        version: entries[0]?.[1].trainVersion,
        trainVersion: entries[0]?.[1].trainVersion,
        releases: Object.fromEntries(entries),
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
