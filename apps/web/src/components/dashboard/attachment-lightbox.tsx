"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MediaSkeleton } from "./content-skeleton";
import {
  SLIDE_GAP,
  ZOOM_STEP,
  createImageViewer,
  type GalleryImage,
  type ImageViewerState,
} from "./image-viewer-controller";

export type { GalleryImage } from "./image-viewer-controller";

export const LIGHTBOX_BUTTON_CLASS =
  "flex items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition hover:bg-black/75";

/** The dim full-screen layer an attachment opens on, with its close control.
    `fullBleed` content takes the whole screen (a zoomable image) instead of a centred box. */
export function AttachmentLightbox({
  label,
  onRequestClose,
  actions,
  fullBleed = false,
  closing = false,
  rootRef,
  backdropRef,
  chromeRef,
  children,
}: {
  label: string;
  onRequestClose: () => void;
  actions?: ReactNode;
  fullBleed?: boolean;
  closing?: boolean;
  rootRef?: Ref<HTMLDivElement>;
  backdropRef?: Ref<HTMLDivElement>;
  chromeRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null;
  const closeOnSurround = (event: { target: EventTarget; currentTarget: EventTarget }) => {
    if (!fullBleed && event.target === event.currentTarget) onRequestClose();
  };
  return createPortal(
    <div
      ref={rootRef}
      className={cn(
        "app-attachment-lightbox fixed inset-0 z-50 flex items-center justify-center p-3 text-white sm:p-5",
        // On its way out the viewer no longer holds the page.
        closing && "pointer-events-none"
      )}
      role="presentation"
      onMouseDown={closeOnSurround}
    >
      <div
        ref={backdropRef}
        aria-hidden="true"
        className="app-attachment-lightbox-backdrop pointer-events-none absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn(
          "app-attachment-lightbox-dialog flex items-center justify-center",
          fullBleed ? "absolute inset-0" : "relative h-full max-h-[94dvh] w-full max-w-[96vw] flex-col"
        )}
        onMouseDown={closeOnSurround}
      >
        {children}
        <div
          ref={chromeRef}
          className={cn(
            "app-attachment-lightbox-chrome pointer-events-none absolute z-20 *:pointer-events-auto",
            fullBleed ? "inset-3 sm:inset-5" : "inset-0"
          )}
        >
          <button
            type="button"
            title="Close attachment"
            aria-label="Close attachment"
            autoFocus
            onClick={onRequestClose}
            className={cn("app-attachment-lightbox-close absolute right-1 top-1 size-10", LIGHTBOX_BUTTON_CLASS)}
          >
            <X className="size-5" />
          </button>
          {actions}
        </div>
      </div>
    </div>,
    document.body
  );
}

type Slide = { key: string; image: GalleryImage; offset: -1 | 0 | 1 };

/** The open image and its neighbours, already decoding so a swipe never waits.
    With two images the other one sits on both sides, so each side is its own element. */
function gallerySlides(images: readonly GalleryImage[], index: number): Slide[] {
  const count = images.length;
  const current = images[index];
  if (!current) return [];
  if (count === 1) return [{ key: current.id, image: current, offset: 0 }];
  const previous = images[(index - 1 + count) % count];
  const next = images[(index + 1) % count];
  const twin = count === 2;
  return [
    { key: twin ? `previous:${previous.id}` : previous.id, image: previous, offset: -1 },
    { key: current.id, image: current, offset: 0 },
    { key: twin ? `next:${next.id}` : next.id, image: next, offset: 1 },
  ];
}

function GallerySlide({
  slide,
  current,
  zoomed,
  register,
  onReady,
}: {
  slide: Slide;
  current: boolean;
  zoomed: boolean;
  register: (key: string, element: HTMLImageElement | null) => void;
  onReady: (key: string) => void;
}) {
  const { key, image, offset } = slide;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [shownSrc, setShownSrc] = useState(image.src);
  if (shownSrc !== image.src) {
    setShownSrc(image.src);
    setPhase("loading");
  }
  const setImage = useCallback((element: HTMLImageElement | null) => {
    imageRef.current = element;
    register(key, element);
  }, [key, register]);

  useLayoutEffect(() => {
    // Already decoded (the thumbnail fetched it): ready before the first paint.
    const element = imageRef.current;
    if (phase === "loading" && element?.complete && element.naturalWidth > 0) setPhase("ready");
  }, [phase, image.src]);

  useLayoutEffect(() => {
    if (phase === "ready" && current) onReady(key);
  }, [phase, current, key, onReady]);

  return (
    <div
      className={cn(
        // Each image is clipped to its own page, so a zoomed one sliding away never covers its neighbour.
        "app-image-viewer-slide absolute inset-0 flex items-center justify-center overflow-hidden p-3 sm:p-5",
        current && "z-[1]"
      )}
      style={offset === 0 ? undefined : { transform: `translate3d(calc(${offset} * (100% + ${SLIDE_GAP}px)), 0, 0)` }}
      aria-hidden={current ? undefined : true}
    >
      {phase === "loading" && (
        <MediaSkeleton label="Loading image" announce={current} className="app-media-skeleton-stage" />
      )}
      {phase === "failed" ? (
        <span className="app-media-unavailable text-white" role="status">Attachment unavailable</span>
      ) : image.src ? (
        // eslint-disable-next-line @next/next/no-img-element -- Attachments are user-provided object and data URLs.
        <img
          ref={setImage}
          src={image.src}
          alt={phase === "ready" ? image.name : ""}
          draggable={false}
          onLoad={() => setPhase("ready")}
          onError={() => setPhase("failed")}
          className={cn(
            "app-attachment-lightbox-image max-h-full max-w-full select-none object-contain",
            current && !zoomed && "cursor-zoom-in",
            phase !== "ready" && "app-loading-image-pending"
          )}
        />
      ) : null}
    </div>
  );
}

/** Where images open: pinch, wheel, double-tap or click to zoom; drag to pan; swipe or arrow keys
    between images; drag down, tap or Escape to close. It opens out of its thumbnail and returns
    into it. The owner keeps which image is open and unmounts the viewer when `onClose` runs. */
export function ImageGalleryLightbox({
  images,
  activeId,
  onActiveChange,
  onClose,
  originFor,
  actions,
}: ImageViewerState & { actions?: ReactNode }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const live = useRef<ImageViewerState>({ images, activeId, onActiveChange, onClose, originFor });
  const [imageElements] = useState(() => new Map<string, HTMLImageElement>());
  const [zoom, setZoom] = useState({ zoomed: false, percent: 100 });
  const [closing, setClosing] = useState(false);
  const [viewer] = useState(() => createImageViewer({
    viewport: () => viewportRef.current,
    track: () => trackRef.current,
    backdrop: () => backdropRef.current,
    chrome: () => chromeRef.current,
    images: imageElements,
    state: () => live.current,
    zoomChanged: setZoom,
    closing: () => setClosing(true),
  }));

  useLayoutEffect(() => {
    live.current = { images, activeId, onActiveChange, onClose, originFor };
  });

  useLayoutEffect(() => {
    viewer.activeChanged();
  }, [activeId, viewer]);

  useLayoutEffect(() => {
    viewer.mounted();
    return () => viewer.dispose();
  }, [viewer]);

  useEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    if (!root || !viewport) return;
    // Touch scrolling and page zoom stay out of the viewer, Safari's included.
    const holdTouch = (event: TouchEvent) => event.preventDefault();
    viewport.addEventListener("pointerdown", viewer.pointerDown);
    viewport.addEventListener("pointermove", viewer.pointerMove);
    viewport.addEventListener("pointerup", viewer.pointerUp);
    viewport.addEventListener("pointercancel", viewer.pointerCancel);
    viewport.addEventListener("touchmove", holdTouch, { passive: false });
    root.addEventListener("wheel", viewer.wheel, { passive: false });
    root.addEventListener("gesturestart", viewer.safariGestureStart);
    root.addEventListener("gesturechange", viewer.safariGestureChange);
    root.addEventListener("gestureend", viewer.safariGestureEnd);
    document.addEventListener("keydown", viewer.keyDown);
    const resize = new ResizeObserver(() => viewer.resized());
    resize.observe(viewport);
    return () => {
      viewport.removeEventListener("pointerdown", viewer.pointerDown);
      viewport.removeEventListener("pointermove", viewer.pointerMove);
      viewport.removeEventListener("pointerup", viewer.pointerUp);
      viewport.removeEventListener("pointercancel", viewer.pointerCancel);
      viewport.removeEventListener("touchmove", holdTouch);
      root.removeEventListener("wheel", viewer.wheel);
      root.removeEventListener("gesturestart", viewer.safariGestureStart);
      root.removeEventListener("gesturechange", viewer.safariGestureChange);
      root.removeEventListener("gestureend", viewer.safariGestureEnd);
      document.removeEventListener("keydown", viewer.keyDown);
      resize.disconnect();
    };
  }, [viewer]);

  const register = useCallback((key: string, element: HTMLImageElement | null) => {
    if (element) imageElements.set(key, element);
    else imageElements.delete(key);
  }, [imageElements]);

  const index = Math.max(0, images.findIndex((image) => image.id === activeId));
  const count = images.length;
  const slides = gallerySlides(images, index);

  return (
    <AttachmentLightbox
      label={images[index]?.name ?? "Image"}
      onRequestClose={viewer.requestClose}
      fullBleed
      closing={closing}
      rootRef={rootRef}
      backdropRef={backdropRef}
      chromeRef={chromeRef}
      actions={
        <>
          {actions}
          {count > 1 && (
            <>
              <button
                type="button"
                title="Previous image"
                aria-label="Previous image"
                onClick={() => viewer.navigate(-1)}
                className={cn("app-attachment-lightbox-previous absolute left-1 top-1/2 size-11 -translate-y-1/2", LIGHTBOX_BUTTON_CLASS)}
              >
                <ChevronLeft className="size-6" />
              </button>
              <button
                type="button"
                title="Next image"
                aria-label="Next image"
                onClick={() => viewer.navigate(1)}
                className={cn("app-attachment-lightbox-next absolute right-1 top-1/2 size-11 -translate-y-1/2", LIGHTBOX_BUTTON_CLASS)}
              >
                <ChevronRight className="size-6" />
              </button>
            </>
          )}
          <div
            className={cn(
              "app-image-viewer-toolbar absolute bottom-1 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/55 p-1 text-xs font-bold text-white shadow-lg",
              // Touch zooms with the fingers; the bar is only worth showing there when it counts images.
              count < 2 && "pointer-coarse:hidden"
            )}
          >
            <div className="flex items-center gap-0.5 pointer-coarse:hidden">
              <button
                type="button"
                title="Zoom out"
                aria-label="Zoom out"
                disabled={!zoom.zoomed}
                onClick={() => viewer.zoomBy(1 / ZOOM_STEP)}
                className="flex size-8 items-center justify-center rounded-full transition hover:bg-white/15 disabled:pointer-events-none disabled:opacity-40"
              >
                <Minus className="size-4" />
              </button>
              <button
                type="button"
                title={zoom.zoomed ? "Fit to screen" : "Actual size"}
                aria-label={zoom.zoomed ? `Zoom ${zoom.percent}%, fit to screen` : `Zoom ${zoom.percent}%, actual size`}
                onClick={viewer.toggleActualSize}
                className="h-8 min-w-14 rounded-full px-2 tabular-nums transition hover:bg-white/15"
              >
                {zoom.percent}%
              </button>
              <button
                type="button"
                title="Zoom in"
                aria-label="Zoom in"
                onClick={() => viewer.zoomBy(ZOOM_STEP)}
                className="flex size-8 items-center justify-center rounded-full transition hover:bg-white/15"
              >
                <Plus className="size-4" />
              </button>
            </div>
            {count > 1 && (
              <span className="app-image-viewer-count px-2.5 tabular-nums">
                {index + 1} / {count}
              </span>
            )}
          </div>
        </>
      }
    >
      <div
        ref={viewportRef}
        className={cn(
          "app-attachment-lightbox-zoom fixed inset-0 overflow-hidden",
          zoom.zoomed && "cursor-grab active:cursor-grabbing"
        )}
      >
        <div ref={trackRef} className="app-image-viewer-track absolute inset-0">
          {slides.map((slide) => (
            <GallerySlide
              key={slide.key}
              slide={slide}
              current={slide.offset === 0}
              zoomed={zoom.zoomed}
              register={register}
              onReady={viewer.imageReady}
            />
          ))}
        </div>
      </div>
    </AttachmentLightbox>
  );
}
