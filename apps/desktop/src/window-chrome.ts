/** The wood app's paper (`oklch(0.955 0.015 83)`), so native frames and
 * the first paint before the page loads are the same surface as the app. */
export const DEFAULT_SHELL_BACKGROUND_COLOR = "#f5efe5";

/** Windows draws its own minimize/maximize/close over the page. The band is
 * transparent so the paper panel shows through; the glyphs take the app ink
 * (`oklch(0.24 0.03 60)`). The page reads the band's size from
 * `env(titlebar-area-*)` and keeps its own controls out of it. */
export const WINDOWS_TITLE_BAR_OVERLAY = {
  color: "#00000000",
  symbolColor: "#2a1c10",
  height: 36,
} as const;

/** macOS insets the traffic lights into the page; Windows drops the system
 * title bar and menu bar and overlays the caption buttons; Linux keeps its
 * window manager's frame. */
export function desktopTitleBarOptions(platform: NodeJS.Platform, macTrafficLightPosition: { x: number; y: number }) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset" as const, trafficLightPosition: macTrafficLightPosition };
  }
  if (platform === "win32") {
    return { titleBarStyle: "hidden" as const, titleBarOverlay: { ...WINDOWS_TITLE_BAR_OVERLAY } };
  }
  return { titleBarStyle: "default" as const };
}
