/**
 * The workspace app, bundled into the xMatrix Chrome extension.
 *
 * This is the Web's `/app` (app/(en)/workspace) with nothing of the Web around
 * it: the same providers, gate and shell, mounted in a packaged page that the
 * extension's side panel frames (src/lib/extension-embed.ts). The build
 * (apps/chrome-extension/scripts/build-app.mjs) resolves the few Next modules
 * the shell imports to the files beside this one, and lists the Web's proxy
 * routes for local-api.ts to answer in the page.
 */
import { createRoot } from "react-dom/client";
import { API_ROUTES } from "xmatrix-extension:api-routes";
import { AppPreparationGate } from "@/components/app-preparation/app-preparation-gate";
import { HubPreconnect } from "@/components/app-preparation/hub-preconnect";
import WorkspaceAppShell from "@/components/dashboard/workspace-app-shell";
import { LiquidGlassFilter } from "@/components/ui/liquid-glass-filter";
import { LiquidGlassLensDefs } from "@/components/ui/liquid-glass-lens";
import { OverlayScrollbars } from "@/components/ui/overlay-scrollbars";
import { AuthProvider } from "@/lib/auth-context";
import { installLocalApi } from "./local-api";
import { startNavigation } from "./navigation";

startNavigation();
installLocalApi(API_ROUTES);

createRoot(document.body).render(
  <>
    <LiquidGlassFilter />
    <LiquidGlassLensDefs />
    <OverlayScrollbars />
    <AuthProvider>
      <HubPreconnect />
      <AppPreparationGate>
        <WorkspaceAppShell />
      </AppPreparationGate>
    </AuthProvider>
  </>,
);
