import {
  fetchDevRelease,
  fetchLatestStableDesktopMacRelease,
  fetchLatestStableDesktopWindowsRelease,
  releaseRedirectResponse,
  type ReleaseAssetRouteContext,
} from "@/lib/github-release";

export async function GET(request: Request, context: ReleaseAssetRouteContext) {
  return releaseRedirectResponse(request, context, () => resolveRelease(context), "xMatrix desktop release download is unavailable right now.");
}

async function resolveRelease(context: ReleaseAssetRouteContext) {
  const { asset } = await context.params;
  if (!isVersionedDesktopAsset(asset)) return fetchDevRelease("desktop");
  return isWindowsDesktopAsset(asset)
    ? fetchLatestStableDesktopWindowsRelease()
    : fetchLatestStableDesktopMacRelease();
}

function isVersionedDesktopAsset(assetName: string) {
  return /^xMatrix-\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?-/.test(assetName);
}

function isWindowsDesktopAsset(assetName: string) {
  return assetName.endsWith(".exe") || assetName.endsWith(".exe.blockmap");
}
