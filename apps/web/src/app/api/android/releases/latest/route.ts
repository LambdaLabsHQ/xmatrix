import { releaseManifestResponse } from "@/lib/github-release";

export async function GET(request: Request) {
  return releaseManifestResponse(request, "android-v", "/api/android/releases/stable", "xMatrix Android releases are unavailable right now.");
}
