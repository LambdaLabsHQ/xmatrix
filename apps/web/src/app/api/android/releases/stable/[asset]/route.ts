import {
  fetchLatestStableAndroidRelease,
  findAndroidReleaseAssetByAlias,
  releaseRedirectResponse,
  type ReleaseAssetRouteContext,
} from "@/lib/github-release";

export async function GET(request: Request, context: ReleaseAssetRouteContext) {
  return releaseRedirectResponse(
    request,
    context,
    fetchLatestStableAndroidRelease,
    "xMatrix Android release download is unavailable right now.",
    findAndroidReleaseAssetByAlias
  );
}
