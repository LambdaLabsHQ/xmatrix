"use client";

import { useSyncExternalStore } from "react";
import { AlertCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SentUpload } from "./sent-upload";

const RADIUS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The progress of a file sent while still uploading, drawn over its tile in
 * the pending message. It reads the upload itself, so a progress tick repaints
 * this ring and nothing else.
 */
export function SentUploadProgress({ upload, media }: { upload: SentUpload; media: boolean }) {
  const state = useSyncExternalStore(upload.subscribe, upload.state, upload.state);
  if (state.status === "uploaded") return null;
  const failed = state.status === "failed";
  const measured = state.status === "uploading" || state.status === "compressing";
  const progress = Math.max(0, Math.min(100, Math.round(state.progress)));
  const label = failed
    ? `Couldn't upload ${upload.preview.name}`
    : state.status === "compressing"
      ? `Compressing ${upload.preview.name} ${progress}%`
      : state.status === "uploading"
        ? `Uploading ${upload.preview.name} ${progress}%`
        : `Preparing ${upload.preview.name}`;
  return (
    <span
      role={failed ? "img" : "progressbar"}
      aria-label={label}
      title={label}
      {...(!failed && measured ? { "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": progress } : {})}
      className={cn(
        "sent-upload-progress flex items-center justify-center",
        media ? "absolute inset-0 z-10 bg-black/35 text-white" : "shrink-0 text-muted-foreground",
      )}
    >
      {failed ? (
        <AlertCircle className={cn("size-7", media ? "text-white" : "text-destructive")} aria-hidden="true" />
      ) : (
        <svg viewBox="0 0 36 36" className={cn("size-9", !measured && "animate-spin")} aria-hidden="true">
          <circle cx="18" cy="18" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
          <circle
            cx="18" cy="18" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
            transform="rotate(-90 18 18)"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - (measured ? progress : 25) / 100)}
            className="transition-[stroke-dashoffset] duration-200"
          />
        </svg>
      )}
    </span>
  );
}
