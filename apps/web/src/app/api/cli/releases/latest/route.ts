import { releaseManifestResponse } from "@/lib/github-release";

export async function GET(request: Request) {
  return releaseManifestResponse(request, "cli-v", "/api/cli/releases/latest", "xMatrix CLI releases are unavailable right now.");
}
