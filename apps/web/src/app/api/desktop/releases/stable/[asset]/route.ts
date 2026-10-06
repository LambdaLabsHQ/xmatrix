import {
  desktopChannelRedirectResponse,
  fetchLatestStableDesktopMacRelease,
  fetchLatestStableDesktopWindowsRelease,
  type ReleaseAssetRouteContext,
} from "@/lib/github-release";

export async function GET(request: Request, context: ReleaseAssetRouteContext) {
  return desktopChannelRedirectResponse(request, context, "stable", () => resolveStableDesktopRelease(context));
}

async function resolveStableDesktopRelease(context: ReleaseAssetRouteContext) {
  const { asset } = await context.params;
  return isWindowsDesktopAsset(asset)
    ? fetchLatestStableDesktopWindowsRelease()
    : fetchLatestStableDesktopMacRelease();
}

function isWindowsDesktopAsset(assetName: string) {
  return assetName === "latest.yml" || assetName.endsWith(".exe") || assetName.endsWith(".exe.blockmap");
}
