import { fetchDevRelease, releaseManifestResponse } from "@/lib/github-release";

export async function GET(request: Request) {
  return releaseManifestResponse(
    request,
    () => fetchDevRelease("cli"),
    "/api/cli/releases/dev",
    "xMatrix CLI dev releases are unavailable right now."
  );
}
