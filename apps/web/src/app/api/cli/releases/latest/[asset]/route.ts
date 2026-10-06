import {
  fetchLatestStableCliRelease,
  releaseProxyResponse,
  type ReleaseAssetRouteContext,
} from "@/lib/github-release";

export async function GET(request: Request, context: ReleaseAssetRouteContext) {
  return releaseProxyResponse(
    request,
    context,
    fetchLatestStableCliRelease,
    "xMatrix CLI release download is unavailable right now."
  );
}
