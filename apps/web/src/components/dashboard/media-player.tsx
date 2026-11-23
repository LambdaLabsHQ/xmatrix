"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { Download, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { directMediaLink } from "./attachment-media-type";
import {
  noteMessageAttachmentVideoDimensions,
  type MessageAttachmentMediaProgress,
  type MessageAttachmentMediaStore,
} from "./message-attachment-media-store";
import { formatFileSize } from "./workspace-shell-recovered";

/** Uses the host browser's decoder, including Chromium in the Electron shell. */
export function MediaPlayer({ kind, src, name, poster, className, autoPlay = false, onVideoDimensions }: {
  kind: "video" | "audio";
  src: string;
  name: string;
  poster?: string;
  className?: string;
  autoPlay?: boolean;
  onVideoDimensions?: (dimensions: { width: number; height: number }) => void;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (failedSource === src) {
    return <span role="status" className="flex h-full min-h-16 items-center justify-center bg-muted p-3 text-sm text-muted-foreground">
      This media could not be played. Download it or open the original link.
    </span>;
  }
  const props = {
    src, controls: true, preload: "metadata", autoPlay,
    "aria-label": name,
    onError: () => setFailedSource(src),
  };
  return kind === "video"
    ? <video
        key={src}
        {...props}
        poster={poster}
        playsInline
        className={className}
        onLoadedMetadata={onVideoDimensions ? (event) => {
          const { videoWidth, videoHeight } = event.currentTarget;
          if (videoWidth > 0 && videoHeight > 0) {
            onVideoDimensions({ width: videoWidth, height: videoHeight });
          }
        } : undefined}
      />
    : <audio key={src} {...props} className="w-full" />;
}

function positiveDimension(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Inline message video player that respects the video's original aspect ratio
 * using stored attachment metadata first and decoded video metadata once loaded.
 */
export function MessageVideoAttachment({
  name,
  source,
  poster,
  width,
  height,
  mediaLoadFailed,
  mediaProgress,
  mediaStore,
  onOpen,
  onDownload,
  unavailable,
  uploadOverlay,
}: {
  name: string;
  source: string;
  poster?: string;
  width?: number;
  height?: number;
  mediaLoadFailed: boolean;
  mediaProgress?: MessageAttachmentMediaProgress;
  mediaStore: MessageAttachmentMediaStore;
  onOpen: () => void;
  onDownload: () => void;
  unavailable: ReactNode;
  uploadOverlay?: ReactNode;
}) {
  const [measured, setMeasured] = useState<{ src: string; width: number; height: number } | null>(null);
  const storedDimensions = source ? mediaStore.videoDimensions.get(source) : undefined;
  const activeMeasured = measured && measured.src === source ? measured : storedDimensions;
  const resolvedWidth = positiveDimension(activeMeasured?.width) ?? positiveDimension(width);
  const resolvedHeight = positiveDimension(activeMeasured?.height) ?? positiveDimension(height);
  const rawAspect = resolvedWidth && resolvedHeight ? resolvedWidth / resolvedHeight : undefined;
  const aspectRatio = rawAspect && Number.isFinite(rawAspect) && rawAspect > 0
    ? Math.max(0.01, Math.min(100, rawAspect))
    : undefined;
  const style = aspectRatio !== undefined
    ? ({ "--message-video-aspect": String(Number(aspectRatio.toFixed(6))) } as CSSProperties)
    : undefined;

  return (
    <div
      className="message-video-attachment relative overflow-hidden border border-border bg-black"
      style={style}
    >
      {source ? (
        <MediaPlayer
          kind="video"
          name={name}
          src={source}
          poster={poster}
          className="absolute inset-0 h-full w-full bg-black object-contain"
          onVideoDimensions={(dimensions) => {
            noteMessageAttachmentVideoDimensions(mediaStore, source, dimensions);
            if (
              positiveDimension(width) === dimensions.width &&
              positiveDimension(height) === dimensions.height &&
              (!measured || measured.src !== source)
            ) {
              return;
            }
            setMeasured((current) =>
              current?.src === source &&
              current.width === dimensions.width &&
              current.height === dimensions.height
                ? current
                : { src: source, ...dimensions }
            );
          }}
        />
      ) : mediaLoadFailed ? (
        unavailable
      ) : (
        <MediaDownloadProgress label="Downloading video" progress={mediaProgress} />
      )}
      {uploadOverlay}
      <button
        type="button"
        title={`Open ${name}`}
        aria-label={`Open ${name}`}
        onClick={onOpen}
        className="absolute left-2 top-2 z-10 flex size-9 items-center justify-center rounded-full bg-black/65 text-white shadow-lg transition hover:bg-black/80"
      >
        <Maximize2 className="size-4.5" />
      </button>
      {source && (
        <button
          type="button"
          title={`Download ${name}`}
          aria-label={`Download ${name}`}
          onClick={onDownload}
          className="absolute right-2 top-2 z-10 flex size-9 items-center justify-center rounded-full bg-black/65 text-white shadow-lg transition hover:bg-black/80"
        >
          <Download className="size-4.5" />
        </button>
      )}
    </div>
  );
}

/** External media is contacted only when the reader explicitly opens its preview. */
export function MediaLink({ href, children }: { href: string; children: ReactNode }) {
  const [openedHref, setOpenedHref] = useState<string | null>(null);
  const opened = openedHref === href;
  const kind = directMediaLink(href);
  return <span className="inline-block max-w-full align-top">
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2">{children}</a>
    {kind && <>
      <button type="button" className="ml-2 text-xs text-primary underline" aria-expanded={opened} onClick={() => setOpenedHref(opened ? null : href)}>
        {opened ? "Close media" : "Preview media"}
      </button>
      {opened && <span className="mt-2 block max-w-full">
        <MediaPlayer kind={kind} src={href} name="Linked media" className="max-h-[28rem] max-w-full bg-black object-contain" />
      </span>}
    </>}
  </span>;
}

/**
 * Media whose body is still downloading. Shows how far along it is so a large
 * video reads as on its way rather than as a frozen black box.
 */
export function MediaDownloadProgress({ label, progress, className }: {
  label: string;
  progress?: MessageAttachmentMediaProgress;
  className?: string;
}) {
  const total = progress?.total ?? null;
  const received = progress?.received ?? 0;
  const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
  const detail = !progress
    ? undefined
    : total ? `${formatFileSize(received)} / ${formatFileSize(total)}` : formatFileSize(received);
  return <span
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={percent ?? undefined}
    aria-valuetext={detail}
    className={cn("media-download-progress", className)}
  >
    <span className="text-sm font-medium tabular-nums">{percent === null ? label : `${label} ${percent}%`}</span>
    <span className="media-download-progress-track">
      <span
        className="media-download-progress-bar"
        data-indeterminate={percent === null || undefined}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </span>
    {detail && <span className="text-xs tabular-nums opacity-70">{detail}</span>}
  </span>;
}
