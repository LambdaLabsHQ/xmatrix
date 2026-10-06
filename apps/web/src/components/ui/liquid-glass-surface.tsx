"use client";

import React from "react";
import { cn } from "@/lib/utils";

import { useLiquidGlassLens } from "./liquid-glass-lens";
import { liquidGlassLensVersion, liquidGlassMaterialStyle, type LiquidGlassMaterial } from "./liquid-glass-material";

type LiquidGlassSurfaceProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  disabled?: boolean;
  enabled?: boolean;
  fill?: boolean;
  href?: string;
  prefetch?: boolean;
  className?: string;
  type?: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
  /** This surface's own glass parameters; unset fields follow its context. */
  material?: LiquidGlassMaterial;
};

export const LiquidGlassSurface = React.forwardRef<HTMLElement, LiquidGlassSurfaceProps>(function LiquidGlassSurface(
{
  as,
  enabled = true,
  fill = false,
  className,
  material,
  style,
  ...props
},
ref
) {
  const Component = as || "div";
  const surfaceRef = React.useRef<HTMLElement | null>(null);
  const setRef = React.useCallback(
    (node: HTMLElement | null) => {
      surfaceRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );
  useLiquidGlassLens(surfaceRef, enabled && fill, liquidGlassLensVersion(material));

  return (
    <Component
      ref={setRef}
      className={cn(className, enabled && "app-liquid-glass-surface border-transparent", enabled && fill && "app-liquid-glass-fill")}
      style={material ? { ...liquidGlassMaterialStyle(material), ...style } : style}
      {...props}
    />
  );
});
