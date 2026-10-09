/** Set on <html> where native scrollbars take layout room; OverlayScrollbars then draws them instead. */
export const OVERLAY_SCROLLBARS_ATTRIBUTE = "data-overlay-scrollbars";

/**
 * Run by the root layout before first paint. Only engines that let
 * `::-webkit-scrollbar` hide the native bars switch over; elsewhere a classic
 * scrollbar stays rather than being drawn twice.
 */
export const OVERLAY_SCROLLBARS_MODE_SCRIPT = `
  try {
    if (CSS.supports("selector(::-webkit-scrollbar)")) {
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;top:-999px;width:100px;height:100px;overflow:scroll";
      document.documentElement.appendChild(probe);
      if (probe.offsetWidth - probe.clientWidth > 0) document.documentElement.setAttribute("${OVERLAY_SCROLLBARS_ATTRIBUTE}", "");
      probe.remove();
    }
  } catch {}
`;
