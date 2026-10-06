/* The message surface carries floating overlays (the composer, the agent work
   dock) whose geometry the scrolling timeline has to stay clear of. The
   composer publishes its own height as --app-composer-height, and the dock is
   anchored to that variable in CSS.
 *
 * That anchoring is the reason this event exists. When the composer grows, the
 * dock only *moves*: its own box does not change size, and neither does the
 * surface, so a ResizeObserver watching either one is never delivered and any
 * measurement the dock published stays stale. Observing the composer element
 * from the dock does not fix it either -- ResizeObserver callbacks are
 * delivered in observer-creation order, so the dock could be called before the
 * composer has written the new height and would measure the old position, with
 * nothing scheduled to correct it.
 *
 * So the writer announces instead: the composer dispatches this event on the
 * surface immediately after writing the variable, and readers re-measure. */
export const MESSAGE_SURFACE_METRICS_EVENT = "xmatrix-message-surface-metrics";

/** The surface every message overlay measures itself against. */
export const MESSAGE_SURFACE_SELECTOR = ".app-message-surface";

export function messageSurfaceOf(element: Element | null): HTMLElement | null {
  return (element?.closest(MESSAGE_SURFACE_SELECTOR) as HTMLElement | null) ?? null;
}
