"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const LINE_WIDTHS = ["long", "medium"] as const;
const LIST_WIDTHS = ["long", "medium", "long", "short"] as const;
const CHANNEL_SKELETON_ROWS = [
  ["72%", "48%"],
  ["56%", "64%"],
  ["80%", "40%"],
  ["48%", "58%"],
  ["68%", "36%"],
  ["60%", "52%"],
] as const;

/** Stacked text bars for a panel that has nothing to show yet. */
export function ContentSkeleton({
  label,
  lines = 4,
  className,
}: {
  label: string;
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("app-content-skeleton", className)} role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          className="app-content-skeleton-line"
          data-width={index === lines - 1 ? "short" : LINE_WIDTHS[index % LINE_WIDTHS.length]}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/** Rows shaped like a list entry: a mark, a title, and a second line. */
export function ListSkeleton({
  label,
  rows = 4,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("app-list-skeleton", className)} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="app-list-skeleton-row" aria-hidden="true">
          <span className="app-list-skeleton-mark" />
          <span className="app-list-skeleton-copy">
            <span className="app-content-skeleton-line" data-width={LIST_WIDTHS[index % LIST_WIDTHS.length]} />
            <span className="app-content-skeleton-line" data-width="short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** A fast empty fetch should not paint a skeleton. Under this, the skeleton
 *  appears after the content would already have arrived, so the flash is the
 *  slower experience. */
export const EMPTY_SURFACE_SKELETON_DELAY_MS = 300;

/** True only after an empty surface has stayed empty and loading past the delay.
 *  Starts false so the first paint matches the server and a sub-delay fetch
 *  never shows the skeleton. */
export function useEmptySurfaceSkeleton(
  emptyAndLoading: boolean,
  delayMs = EMPTY_SURFACE_SKELETON_DELAY_MS,
): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!emptyAndLoading) {
      setShow(false);
      return;
    }
    const timer = window.setTimeout(() => setShow(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [emptyAndLoading, delayMs]);
  return show;
}

/** Conversation rows for the channel list while the catalog is still arriving. */
export function ChannelListSkeleton({
  label = "Loading channels",
  rows = 6,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="app-channel-list-skeleton" role="status" aria-label={label}>
      {CHANNEL_SKELETON_ROWS.slice(0, rows).map(([title, preview], index) => (
        <div key={index} className="app-channel-skeleton-row" aria-hidden="true">
          <span className="app-channel-skeleton-title" style={{ width: title }} />
          <span className="app-channel-skeleton-preview" style={{ width: preview }} />
        </div>
      ))}
    </div>
  );
}

/** A matte block in the shape of the thing that is still loading. No icon. */
export function MediaSkeleton({
  label,
  className,
  announce = true,
}: {
  label?: string;
  className?: string;
  announce?: boolean;
}) {
  return (
    <span
      className={cn("app-media-skeleton", className)}
      {...(announce && label
        ? { role: "status" as const, "aria-label": label }
        : { "aria-hidden": true as const })}
    />
  );
}

/**
 * An image that occupies its box with a skeleton until pixels arrive.
 * The element stays invisible while loading so the browser's broken-image
 * glyph never flashes in its place.
 */
export function LoadingImage({
  src,
  alt,
  className,
  skeletonClassName,
  fallback,
  announce = true,
  draggable,
  referrerPolicy,
  onContextMenu,
}: {
  src: string;
  alt: string;
  className?: string;
  skeletonClassName?: string;
  fallback?: ReactNode;
  announce?: boolean;
  draggable?: boolean;
  referrerPolicy?: "no-referrer" | "origin";
  onContextMenu?: (event: MouseEvent<HTMLImageElement>) => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      setPhase("ready");
      return;
    }
    setPhase("loading");
  }, [src]);

  if (!src) {
    return (
      <MediaSkeleton
        label="Loading image"
        className={cn("app-media-skeleton-image", skeletonClassName)}
        announce={announce}
      />
    );
  }

  return (
    <span className="app-loading-image">
      {phase === "loading" && (
        <MediaSkeleton
          label="Loading image"
          className={cn(skeletonClassName ?? "app-media-skeleton-image")}
          announce={announce}
        />
      )}
      {phase === "failed" ? (
        <span className="app-loading-image-fallback">
          {fallback ?? <span className="app-media-unavailable" role="status">Attachment unavailable</span>}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- Relay, attachment, and local object URLs are not static assets.
        <img
          ref={(node) => {
            imageRef.current = node;
            if (node?.complete && node.naturalWidth > 0) setPhase("ready");
          }}
          src={src}
          alt={phase === "ready" ? alt : ""}
          draggable={draggable}
          referrerPolicy={referrerPolicy}
          onContextMenu={onContextMenu}
          className={cn(className, phase !== "ready" && "app-loading-image-pending")}
          onLoad={() => setPhase("ready")}
          onError={() => setPhase("failed")}
        />
      )}
    </span>
  );
}
