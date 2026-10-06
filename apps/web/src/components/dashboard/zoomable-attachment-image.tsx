"use client";
import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { cn } from "@/lib/utils";
import { MediaSkeleton } from "./content-skeleton";
import { touchPoints, pointerDistance, pointerMidpoint } from "./workspace-shell-helpers";

export function ZoomableAttachmentImage({
  src,
  alt,
  resetKey,
  onRequestClose,
  onNavigate,
}: {
  src: string;
  alt: string;
  resetKey: string;
  onRequestClose: () => void;
  onNavigate?: (direction: -1 | 1) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const gestureRef = useRef<{
    distance: number;
    midpoint: { x: number; y: number };
    pointer: { x: number; y: number } | null;
    transform: { scale: number; x: number; y: number };
  } | null>(null);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const transformRef = useRef(transform);
  const touchingRef = useRef(false);

  useEffect(() => {
    gestureRef.current = null;
    tapStartRef.current = null;
    swipeStartRef.current = null;
    touchingRef.current = false;
    applyTransform({ scale: 1, x: 0, y: 0 });
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      setPhase("ready");
      return;
    }
    setPhase("loading");
  }, [resetKey, src]);

  function applyTransform(next: { scale: number; x: number; y: number }) {
    transformRef.current = next;
    setTransform(next);
  }

  function clampTransform(next: { scale: number; x: number; y: number }) {
    const scale = Math.min(Math.max(next.scale, 1), 5);
    const viewport = viewportRef.current;
    if (!viewport || scale <= 1) return { scale, x: 0, y: 0 };

    const maxX = (viewport.clientWidth * (scale - 1)) / 2;
    const maxY = (viewport.clientHeight * (scale - 1)) / 2;
    return {
      scale,
      x: Math.min(Math.max(next.x, -maxX), maxX),
      y: Math.min(Math.max(next.y, -maxY), maxY),
    };
  }

  function beginGesture(touches: ReactTouchEvent<HTMLDivElement>["touches"]) {
    const pointers = touchPoints(touches);
    gestureRef.current = {
      distance: pointers.length >= 2 ? pointerDistance(pointers[0], pointers[1]) : 0,
      midpoint: pointers.length >= 2 ? pointerMidpoint(pointers[0], pointers[1]) : { x: 0, y: 0 },
      pointer: pointers.length === 1 ? pointers[0] : null,
      transform: transformRef.current,
    };
  }

  function handleTouchStart(event: ReactTouchEvent<HTMLDivElement>) {
    const pointers = touchPoints(event.touches);
    if (!touchingRef.current && pointers.length === 1) {
      tapStartRef.current = pointers[0];
      swipeStartRef.current = transformRef.current.scale === 1 ? pointers[0] : null;
    } else if (pointers.length !== 1) {
      tapStartRef.current = null;
      swipeStartRef.current = null;
    }
    touchingRef.current = event.touches.length > 0;
    event.preventDefault();
    beginGesture(event.touches);
  }

  function handleTouchMove(event: ReactTouchEvent<HTMLDivElement>) {
    if (!touchingRef.current) return;
    event.preventDefault();
    const gesture = gestureRef.current;
    const pointers = touchPoints(event.touches);
    if (!gesture || pointers.length === 0) return;

    const tapStart = tapStartRef.current;
    if (tapStart && (pointers.length !== 1 || pointerDistance(tapStart, pointers[0]) > 8)) {
      tapStartRef.current = null;
    }

    if (pointers.length >= 2 && gesture.distance > 0) {
      const midpoint = pointerMidpoint(pointers[0], pointers[1]);
      const scale = gesture.transform.scale * (pointerDistance(pointers[0], pointers[1]) / gesture.distance);
      applyTransform(
        clampTransform({
          scale,
          x: gesture.transform.x + midpoint.x - gesture.midpoint.x,
          y: gesture.transform.y + midpoint.y - gesture.midpoint.y,
        })
      );
      return;
    }

    if (pointers.length === 1 && gesture.pointer && gesture.transform.scale > 1) {
      const pointer = pointers[0];
      applyTransform(
        clampTransform({
          scale: gesture.transform.scale,
          x: gesture.transform.x + pointer.x - gesture.pointer.x,
          y: gesture.transform.y + pointer.y - gesture.pointer.y,
        })
      );
    }
  }

  function handleTouchEnd(event: ReactTouchEvent<HTMLDivElement>) {
    touchingRef.current = event.touches.length > 0;
    if (event.touches.length > 0) {
      beginGesture(event.touches);
      return;
    }
    const shouldClose = tapStartRef.current !== null && event.target === imageRef.current;
    const swipeStart = swipeStartRef.current;
    const end = event.changedTouches[0];
    swipeStartRef.current = null;
    gestureRef.current = null;
    tapStartRef.current = null;
    if (swipeStart && end && onNavigate) {
      const dx = end.clientX - swipeStart.x;
      const dy = end.clientY - swipeStart.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        onNavigate(dx < 0 ? 1 : -1);
        return;
      }
    }
    if (shouldClose) onRequestClose();
  }

  function handleTouchCancel() {
    swipeStartRef.current = null;
    touchingRef.current = false;
    gestureRef.current = null;
    tapStartRef.current = null;
  }

  return (
    <div
      ref={viewportRef}
      className={cn(
        "app-attachment-lightbox-zoom relative flex h-full max-h-[94dvh] w-full max-w-[96vw] items-center justify-center overflow-hidden",
        transform.scale > 1 && "cursor-grab active:cursor-grabbing"
      )}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onRequestClose();
      }}
    >
      {phase === "loading" && (
        <MediaSkeleton label="Loading image" className="app-media-skeleton-stage" />
      )}
      {phase === "failed" ? (
        <span className="app-media-unavailable text-white" role="status">Attachment unavailable</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- Attachments are user-provided data URLs.
        <img
          ref={imageRef}
          src={src}
          alt={phase === "ready" ? alt : ""}
          draggable={false}
          onLoad={() => setPhase("ready")}
          onError={() => setPhase("failed")}
          className={cn(
            "app-attachment-lightbox-image max-h-[94dvh] max-w-[96vw] select-none object-contain",
            phase !== "ready" && "app-loading-image-pending pointer-events-none absolute",
          )}
          style={{
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
            transition: touchingRef.current ? "none" : "transform 120ms ease-out",
          }}
        />
      )}
    </div>
  );
}
