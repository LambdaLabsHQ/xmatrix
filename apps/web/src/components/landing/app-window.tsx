"use client";

import { useSyncExternalStore } from "react";
import dynamic from "next/dynamic";

// The app's own components measure the window and read browser-only state, so
// they render on the client.
const AppWindowPreview = dynamic(
  () => import("@/components/landing/app-window-preview").then((module) => module.AppWindowPreview),
  { ssr: false },
);

// A desktop shows the macOS window; a phone shows the same app in an iPhone,
// the way the iOS app (a web container) shows it.
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The real xMatrix app in a macOS window on a desktop, in an iPhone on a phone. */
export function AppWindow() {
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
  if (!desktop) {
    return (
      <div className="site-phone" role="img" aria-label="xMatrix on an iPhone, in a conversation where a person, Claude and Codex work on a landing page">
        <div className="site-phone-screen">
          <div className="site-app-window-content" inert>
            <AppWindowPreview />
          </div>
          <span className="site-phone-island" aria-hidden />
        </div>
      </div>
    );
  }

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
