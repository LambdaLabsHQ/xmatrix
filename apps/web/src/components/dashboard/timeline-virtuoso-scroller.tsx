"use client";

import { Children, cloneElement, forwardRef, isValidElement, type ReactNode } from "react";
import type { ScrollerProps } from "react-virtuoso";

type TimelineVirtuosoScrollerProps = Omit<ScrollerProps, "ref"> & { context?: unknown };

/**
 * react-virtuoso 4.18.11 supplies its measured viewport as the last Scroller
 * child, after an optional top-item list. Keep that component, its ref and
 * styles intact, and put its header, rows and footer in one visual layer.
 * Translating the measured viewport itself changes the offset it reports to
 * customScrollParent. The painted-coordinate owner guards this integration
 * when Virtuoso is upgraded; any top-item list stays outside the visual layer.
 */
export const TimelineVirtuosoScroller = forwardRef<HTMLDivElement, TimelineVirtuosoScrollerProps>(
  function TimelineVirtuosoScroller({ children, context: _context, ...attributes }, ref) {
    const nodes = Children.toArray(children);
    const viewport = nodes.at(-1);
    if (isValidElement<{ children?: ReactNode }>(viewport)) {
      nodes[nodes.length - 1] = cloneElement(viewport, undefined,
        // Match the viewport height so its absolute footer probes keep their
        // original bounds when translate makes this layer a containing block.
        // A plain block preserves the existing flow and margin behavior.
        <div data-timeline-rise-content="" style={{ height: "100%" }}>
          {viewport.props.children}
        </div>,
      );
    }
    return <div {...attributes} ref={ref}>{nodes}</div>;
  },
);
