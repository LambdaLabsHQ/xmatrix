import { fetchDevRelease, releaseProxyResponse, type ReleaseAssetRouteContext } from "@/lib/github-release";

export async function GET(request: Request, context: ReleaseAssetRouteContext) {
  return releaseProxyResponse(
    request,
    context,
    () => fetchDevRelease("cli"),
    "xMatrix CLI dev release download is unavailable right now."
  );
}
