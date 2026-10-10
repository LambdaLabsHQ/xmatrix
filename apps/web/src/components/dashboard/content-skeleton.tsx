"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ListSectionHeading, RECENT_SECTION } from "./list-section-heading";
import {
  CHANNEL_CHAT_ROW_CLASS_NAME,
  CHANNEL_ROW_HASH_CLASS_NAME,
  CHANNEL_ROW_NAME_CLASS_NAME,
  CHANNEL_ROW_PREVIEW_CLASS_NAME,
  CHANNEL_ROW_PREVIEW_LINE_CLASS_NAME,
  CHANNEL_ROW_TIME_CLASS_NAME,
  CHANNEL_ROW_TITLE_CLASS_NAME,
  CHANNEL_ROW_TITLE_LINE_CLASS_NAME,
  LIST_ROW_CLASS_NAME,
  LIST_ROW_COPY_CLASS_NAME,
  LIST_ROW_LEADING_CLASS_NAME,
  LIST_ROW_LEADING_TWO_LINE_CLASS_NAME,
  LIST_ROW_META_CLASS_NAME,
  LIST_ROW_TITLE_CLASS_NAME,
  LIST_ROW_TITLE_LINE_CLASS_NAME,
} from "./row-frames";

const LINE_WIDTHS = ["long", "medium"] as const;
const LIST_SKELETON_ROWS = [
  ["9rem", "62%"],
  ["6.5rem", "44%"],
  ["10.5rem", "70%"],
  ["7.5rem", "38%"],
  ["8.5rem", "56%"],
  ["6rem", "48%"],
  ["9.5rem", "66%"],
  ["7rem", "40%"],
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

/** Placeholder rows inside a list row's own boxes (row-frames): only the
 *  mark, the title and the line under it are bars. `mark={false}` for rows
 *  that are text alone. Outside a list column, zero the row's insets. */
export function ListSkeleton({
  label,
  rows = 4,
  mark = true,
  className,
}: {
  label: string;
  rows?: number;
  mark?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("app-list-skeleton", className)} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => {
        const [title, meta] = LIST_SKELETON_ROWS[index % LIST_SKELETON_ROWS.length];
        return (
          <div key={index} className={LIST_ROW_CLASS_NAME} aria-hidden="true">
            {mark && (
              <span className={cn(LIST_ROW_LEADING_CLASS_NAME, LIST_ROW_LEADING_TWO_LINE_CLASS_NAME)}>
                <span className="app-list-skeleton-mark" />
              </span>
            )}
            <span className={LIST_ROW_COPY_CLASS_NAME}>
              <span className={LIST_ROW_TITLE_LINE_CLASS_NAME}>
                <span className={LIST_ROW_TITLE_CLASS_NAME}><span className="app-skeleton-bar" style={{ width: title }} /></span>
              </span>
              <span className={LIST_ROW_META_CLASS_NAME}><span className="app-skeleton-bar" style={{ width: meta }} /></span>
            </span>
          </div>
        );
      })}
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

/** The conversation list while its catalog is still arriving: its section
 *  heading, then placeholder rows inside a conversation row's own boxes
 *  (row-frames). Only the name, the time and the preview are bars. */
export function ChannelListSkeleton({
  label = "Loading channels",
  rows = LIST_SKELETON_ROWS.length,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="app-list-skeleton" role="status" aria-label={label}>
      <div aria-hidden="true">
        <ListSectionHeading {...RECENT_SECTION} />
        {LIST_SKELETON_ROWS.slice(0, rows).map(([title, preview], index) => (
          <div key={index} className={cn(CHANNEL_CHAT_ROW_CLASS_NAME, "flex w-full")}>
            <span className={CHANNEL_ROW_TITLE_LINE_CLASS_NAME}>
              <span className={CHANNEL_ROW_TITLE_CLASS_NAME}>
                <span className={CHANNEL_ROW_HASH_CLASS_NAME}>#</span>
                <span className={CHANNEL_ROW_NAME_CLASS_NAME}><span className="app-skeleton-bar" style={{ width: title }} /></span>
              </span>
              <span className={CHANNEL_ROW_TIME_CLASS_NAME}><span className="app-skeleton-bar" style={{ width: "1.25rem" }} /></span>
            </span>
            <span className={CHANNEL_ROW_PREVIEW_LINE_CLASS_NAME}>
              <span className={CHANNEL_ROW_PREVIEW_CLASS_NAME}><span className="app-skeleton-bar" style={{ width: preview }} /></span>
            </span>
          </div>
        ))}
      </div>
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
