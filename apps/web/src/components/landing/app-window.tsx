"use client";

import { useSyncExternalStore } from "react";
import dynamic from "next/dynamic";

// The app's own components measure the window and read browser-only state, so
// they render on the client.
const AppWindowPreview = dynamic(
  () => import("@/components/landing/app-window-preview").then((module) => module.AppWindowPreview),
  { ssr: false },
);

// Desktop only for now: a phone neither shows nor loads the window.
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The real xMatrix app in a macOS window: traffic lights over the rail, window shadow. */
export function AppWindow() {
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
  if (!desktop) return null;

  return (
    <div
      className="site-app-window"
      role="img"
      aria-label="xMatrix showing a Space's conversations beside one where a person, Claude and Codex work on a landing page"
    >
      <div className="site-app-window-content" inert>
        <AppWindowPreview />
      </div>
      <span className="site-app-window-lights" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
