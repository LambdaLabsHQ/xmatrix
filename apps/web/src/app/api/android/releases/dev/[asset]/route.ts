import {
  fetchDevRelease,
  findAndroidReleaseAssetByAlias,
  releaseRedirectResponse,
  type ReleaseAssetRouteContext,
} from "@/lib/github-release";

export async function GET(request: Request, context: ReleaseAssetRouteContext) {
  return releaseRedirectResponse(
    request,
    context,
    () => fetchDevRelease("android"),
    "xMatrix Android dev release download is unavailable right now.",
    findAndroidReleaseAssetByAlias
  );
}
