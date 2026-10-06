"use client";

import { Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CenteredDialogShell, DialogButton, DialogPanelFooter } from "@/components/dashboard/centered-dialog-shell";
import {
  clampCropView,
  cropRectFromView,
  initialCropView,
  maxCropScale,
  minCropScale,
  zoomCropView,
  type AvatarCropView,
} from "@/lib/human-avatar-crop";
import {
  AvatarImageError,
  decodeAvatarSource,
  releaseAvatarSource,
  renderAvatarCrop,
  type AvatarSource,
  type PreparedAvatar,
} from "@/lib/human-avatar-image";

/** Square the crop works in. The inscribed circle is the avatar. */
const CROP_VIEWPORT_PX = 256;

/**
 * Slack's crop step: picking a file opens the photo behind a fixed circle,
 * dragging moves the photo under it, a slider zooms, and Save is the moment
 * the pixels are chosen. The automatic centre crop this replaces took the
 * framing decision away from the person whose face it is.
 */
export function HumanAvatarCropDialog({
  file,
  onCancel,
  onSave,
  onError,
}: {
  file: File;
  onCancel: () => void;
  /** Receives the encoded avatar; closing the dialog is the caller's move. */
  onSave: (prepared: PreparedAvatar) => void;
  onError: (message: string) => void;
}) {
  const [source, setSource] = useState<AvatarSource | null>(null);
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [view, setView] = useState<AvatarCropView | null>(null);
  const [encoding, setEncoding] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  /* The decode effect must not re-run when the parent re-renders with fresh
     closures, so the callbacks ride a ref and only the file is a dependency. */
  const callbacksRef = useRef({ onCancel, onError });
  callbacksRef.current = { onCancel, onError };

  useEffect(() => {
    let cancelled = false;
    let decoded: AvatarSource | null = null;
    const url = URL.createObjectURL(file);
    setDisplayUrl(url);
    decodeAvatarSource(file).then(
      (result) => {
        if (cancelled) {
          releaseAvatarSource(result);
          return;
        }
        decoded = result;
        setSource(result);
        setView(initialCropView(result.width, result.height, CROP_VIEWPORT_PX));
      },
      (error) => {
        if (cancelled) return;
        callbacksRef.current.onError(
          error instanceof AvatarImageError ? error.message : "Could not use that image.",
        );
        callbacksRef.current.onCancel();
      },
    );
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
      if (decoded) releaseAvatarSource(decoded);
    };
  }, [file]);

  function beginDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!view) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.offsetX,
      originY: view.offsetY,
    };
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setView((current) =>
      current
        ? clampCropView({ ...current, offsetX: drag.originX + dx, offsetY: drag.originY + dy })
        : current,
    );
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  async function save() {
    if (!source || !view || encoding) return;
    setEncoding(true);
    try {
      onSave(await renderAvatarCrop(source, cropRectFromView(view)));
    } catch (error) {
      onError(error instanceof AvatarImageError ? error.message : "Could not use that image.");
      onCancel();
    } finally {
      setEncoding(false);
    }
  }

  const zoomBounds = source
    ? { min: minCropScale({ ...source, viewport: CROP_VIEWPORT_PX }), max: maxCropScale({ ...source, viewport: CROP_VIEWPORT_PX }) }
    : null;

  return (
    <CenteredDialogShell
      open
      busy={encoding}
      labelledBy="human-avatar-crop-title"
      panelClassName="max-w-sm"
      onCancel={onCancel}
    >
      <div className="app-dialog-header border-b border-border px-5 py-4">
        <h2 id="human-avatar-crop-title" className="text-base font-black">
          Crop your photo
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">Drag to reposition. The circle is what everyone sees.</p>
      </div>

      <div className="px-4 py-4">
        <div
          /* touch-action: none is deliberate here: this square exists to be
             dragged, unlike a list, where the browser owns the gesture.
             A dedicated radius class: the theme's rounded-* → pill rewrite
             would turn the square itself into the circle and hide the dimmed
             surround that shows what is being cropped away. */
          className="app-avatar-crop-viewport relative mx-auto cursor-grab touch-none select-none overflow-hidden bg-black/50 active:cursor-grabbing"
          style={{ width: CROP_VIEWPORT_PX, height: CROP_VIEWPORT_PX }}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {displayUrl && view ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local object URL being framed by hand; next/image would refuse or re-fit it.
            <img
              src={displayUrl}
              alt=""
              draggable={false}
              className="pointer-events-none absolute left-0 top-0 max-w-none"
              style={{
                width: view.width * view.scale,
                height: view.height * view.scale,
                transform: `translate(${view.offsetX}px, ${view.offsetY}px)`,
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {/* Everything outside the inscribed circle is dimmed, not hidden:
              the person still sees what they are cropping away. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full border border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
          />
        </div>

        {view && zoomBounds ? (
          <div className="mx-auto mt-4 flex items-center gap-3" style={{ width: CROP_VIEWPORT_PX }}>
            <ZoomOut className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="range"
              aria-label="Zoom"
              min={zoomBounds.min}
              max={zoomBounds.max}
              step={(zoomBounds.max - zoomBounds.min) / 100}
              value={view.scale}
              onChange={(event) => {
                const nextScale = Number(event.target.value);
                setView((current) => (current ? zoomCropView(current, nextScale) : current));
              }}
              className="w-full accent-primary"
            />
            <ZoomIn className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </div>
        ) : null}
      </div>

      <DialogPanelFooter>
        <DialogButton disabled={encoding} onClick={onCancel}>
          Cancel
        </DialogButton>
        <DialogButton tone="primary" busy={encoding} disabled={encoding || !view} onClick={() => void save()}>
          Save
        </DialogButton>
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}
