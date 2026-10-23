"use client";

import type { CSSProperties } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAnimationVisibility } from "./animation-visibility";

/**
 * Animate an HTML surface so Chromium can composite it without updating the
 * paint artifact for an animated SVG root on every frame. Icon geometry and
 * accessibility remain on the static SVG; layout and animation live here.
 */
export function AnimatedIcon({
  icon: Icon,
  className,
  size,
  style,
  ...props
}: Omit<LucideProps, "ref"> & { icon: LucideIcon }) {
  const animationRef = useAnimationVisibility();
  const dimension = size ?? 24;
  const cssSize = typeof dimension === "number" || /^\d+(?:\.\d+)?$/.test(dimension)
    ? `${dimension}px`
    : dimension;
  return (
    <span
      ref={animationRef}
      data-slot="animated-icon"
      data-icon-size={size === undefined ? undefined : "explicit"}
      className={cn("inline-flex h-[var(--animated-icon-size)] w-[var(--animated-icon-size)] shrink-0 align-middle", className)}
      style={{ "--animated-icon-size": cssSize, ...style } as CSSProperties}
    >
      <Icon {...props} size={size} className="size-full" />
    </span>
  );
}
