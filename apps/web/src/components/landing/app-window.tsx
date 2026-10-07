"use client";

import dynamic from "next/dynamic";

// The app's own components measure the window and read browser-only state, so
// they render on the client. The empty frame holds the space meanwhile.
const AppWindowPreview = dynamic(
  () => import("@/components/landing/app-window-preview").then((module) => module.AppWindowPreview),
  { ssr: false },
);

/** The real xMatrix app in a macOS window: traffic lights over the rail, window shadow. */
export function AppWindow() {
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
