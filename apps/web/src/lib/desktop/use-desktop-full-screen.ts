import { useEffect, useState } from "react";

import type { DesktopBridge } from "./bridge";

/** Whether the desktop window is in native full screen. Older shells without
 * the event report false, which keeps the windowed frame. */
export function useDesktopFullScreen(bridge: DesktopBridge | null): boolean {
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => {
    if (!bridge?.onFullScreenChange) return;
    let current = true;
    const unsubscribe = bridge.onFullScreenChange((next) => {
      if (current) setFullScreen(next);
    });
    void bridge.getFullScreen?.().then((next) => {
      if (current) setFullScreen(next);
    }).catch(() => undefined);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [bridge]);
  return fullScreen;
}
