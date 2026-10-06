import { desktopChannelRedirectResponse, fetchDevRelease, type ReleaseAssetRouteContext } from "@/lib/github-release";

export async function GET(request: Request, context: ReleaseAssetRouteContext) {
  return desktopChannelRedirectResponse(request, context, "dev", () => fetchDevRelease("desktop"));
}
