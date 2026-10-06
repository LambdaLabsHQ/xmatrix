import { fetchLatestStableDesktopMacRelease, releaseManifestResponse } from "@/lib/github-release";

export async function GET(request: Request) {
  return releaseManifestResponse(
    request,
    fetchLatestStableDesktopMacRelease,
    "/api/desktop/releases",
    "xMatrix desktop releases are unavailable right now."
  );
}
