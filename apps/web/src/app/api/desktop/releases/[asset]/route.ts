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
  if (!isStableVersionedDesktopAsset(asset)) return fetchDevRelease("desktop");
  return isWindowsDesktopAsset(asset)
    ? fetchLatestStableDesktopWindowsRelease()
    : fetchLatestStableDesktopMacRelease();
}

function isStableVersionedDesktopAsset(assetName: string) {
  const version = /^xMatrix-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)-(?:arm64|x64)\./.exec(assetName)?.[1];
  return Boolean(version && !version.split("+", 1)[0].includes("-"));
}

function isWindowsDesktopAsset(assetName: string) {
  return assetName.endsWith(".exe") || assetName.endsWith(".exe.blockmap");
}
