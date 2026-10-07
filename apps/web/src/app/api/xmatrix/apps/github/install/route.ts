import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom("GET", (_params, url) => {
  const modeParam = url.searchParams.get("mode");
  const mode = modeParam === "add" || modeParam === "manage" || modeParam === "install" || modeParam === "account"
    ? modeParam
    : undefined;
  const installationId = url.searchParams.get("installationId") || undefined;
  return HUB_ROUTES.github_app_install(url.searchParams.get("spaceId") || "", { mode, installationId });
});
