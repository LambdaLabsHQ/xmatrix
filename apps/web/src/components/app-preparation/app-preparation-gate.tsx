"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import {
  admitAppCompatibility,
  admitRememberedAppCompatibility,
  detectAppCompatibilityIdentity,
} from "@/lib/app-client-compatibility";
import { xmatrixHubOrigin } from "@/lib/query/api-client";
import { StartupShell } from "@/components/dashboard/workspace-channel-sidebar";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { markStartup } from "@/lib/startup-timing";

const RETRY_DELAY_MS = 2000;

export function AppPreparationGate(props: { children: React.ReactNode }) {
  // Admission contains no user data. Keep its observers stable when AuthProvider
  // replaces the account-scoped QueryClient, so admitted children do not unmount
  // and cancel/restart all their first authenticated reads.
  const [admissionClient] = useState(() => new QueryClient());
  useEffect(() => () => admissionClient.clear(), [admissionClient]);
  const hubOrigin = xmatrixHubOrigin();
  const identity = useQuery({
    queryKey: ["app-client-identity", hubOrigin],
    queryFn: async () => {
      const detected = await detectAppCompatibilityIdentity();
      return { identity: detected, remembered: admitRememberedAppCompatibility(detected) };
    },
    staleTime: Infinity,
    retry: true,
    retryDelay: RETRY_DELAY_MS,
  }, admissionClient);
  const compatibility = useQuery({
    queryKey: ["app-client-compatibility", hubOrigin, identity.data?.identity],
    enabled: Boolean(identity.data),
    queryFn: async () => {
      const { decision } = await admitAppCompatibility(identity.data!.identity);
      if (!decision.compatible) {
        window.location.replace("/upgrade-required");
        return false;
      }
      return true;
    },
    retry: true,
    retryDelay: RETRY_DELAY_MS,
    staleTime: Infinity,
  }, admissionClient);
  const ready = compatibility.data === true || (compatibility.data === undefined && identity.data?.remembered === true);

  // The server cannot see a native shell; its frame lands right after hydration.
  const frame = useSyncExternalStore(noSubscription, nativeFrame, browserFrame);

  useEffect(() => {
    if (ready) markStartup("shell");
  }, [ready]);

  if (ready) return props.children;
  // The app's own first frame, waiting on the same screen it will open on.
  return <StartupShell {...frame} />;
}

type StartupFrame = { desktopFrameClass?: string; showMobileTabDock: boolean };
const BROWSER_FRAME: StartupFrame = { showMobileTabDock: true };
const FRAMES = new Map<string, StartupFrame>([
  ["darwin", { desktopFrameClass: "xmatrix-desktop-macos", showMobileTabDock: true }],
  ["win32", { desktopFrameClass: "xmatrix-desktop-windows", showMobileTabDock: true }],
  ["ios", { showMobileTabDock: false }],
]);

function noSubscription() {
  return () => {};
}

function browserFrame(): StartupFrame {
  return BROWSER_FRAME;
}

function nativeFrame(): StartupFrame {
  const bridge = getDesktopBridge();
  if (bridge?.client === "ios") return FRAMES.get("ios")!;
  return FRAMES.get(bridge?.platform ?? "") ?? BROWSER_FRAME;
}
