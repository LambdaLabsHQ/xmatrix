"use client";

import type { CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { PreviewScene } from "@/components/landing/app-window-preview";
import { useMedia, useNear } from "@/components/landing/use-media";

// The app's own components measure the window and read browser-only state, so
// they render on the client.
const AppWindowPreview = dynamic(
  () => import("@/components/landing/app-window-preview").then((module) => module.AppWindowPreview),
  { ssr: false },
);

// A desktop shows the macOS window; a phone shows the same app in an iPhone,
// the way the iOS app (a web container) shows it.
const DESKTOP_QUERY = "(min-width: 768px)";

/** The real xMatrix app in a macOS window. The frame is drawn at once; the app in it mounts as it nears the screen. */
function MacWindow() {
  const [frame, near] = useNear<HTMLDivElement>();
  return (
    <div
      ref={frame}
      className="site-app-window"
      role="img"
      aria-label="xMatrix showing a Space's conversations beside one where a person, Claude and Codex work on a landing page"
    >
      <div className="site-app-window-content" inert>
        {near && <AppWindowPreview />}
      </div>
      <span className="site-app-window-lights" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

const PHONE_ART: Record<PreviewScene, string> = {
  landing: "xMatrix on an iPhone, in a conversation where a person, Claude and Codex work on a landing page",
  launch: "xMatrix on an iPhone, in a conversation where a person asks Claude, Codex and Cursor to ship a launch",
};

/**
 * The same app in an iPhone, laid out at an iPhone's width, in the conversation
 * `scene` names. `size` scales the whole phone (1 is 300px wide); `corner`
 * stands it in the lower right corner of the stage that holds it.
 */
export function Phone({ scene = "landing", size, corner = false }: { scene?: PreviewScene; size?: number; corner?: boolean }) {
  const style = {
    ...(size ? { "--site-phone-size": size } : {}),
    ...(corner ? { position: "absolute", right: 0, bottom: 0, margin: 0 } : {}),
  } as CSSProperties;
  const [frame, near] = useNear<HTMLDivElement>();
  return (
    <div ref={frame} className="site-phone" role="img" aria-label={PHONE_ART[scene]} style={style}>
      <div className="site-phone-screen">
        <div className="site-app-window-content" inert>
          {near && <AppWindowPreview scene={scene} />}
        </div>
        <span className="site-phone-island" aria-hidden />
      </div>
    </div>
  );
}

/** The real xMatrix app in a macOS window on a desktop, in an iPhone on a phone. */
export function AppWindow() {
  return useMedia(DESKTOP_QUERY) ? <MacWindow /> : <Phone />;
}
