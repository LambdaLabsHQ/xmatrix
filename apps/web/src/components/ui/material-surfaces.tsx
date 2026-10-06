"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

import { LiquidGlassSurface } from "./liquid-glass-surface";

type MaterialElementProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  disabled?: boolean;
  type?: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
};

type OnSlabProps = {
  /** Same fill as every glass surface, without a nested backdrop-filter. */
  onSlab?: boolean;
};

type LiquidMaterialProps = Omit<
  React.ComponentPropsWithoutRef<typeof LiquidGlassSurface>,
  "fill"
> &
  OnSlabProps;
type LiquidPillProps = React.ComponentPropsWithoutRef<typeof LiquidGlassSurface> & OnSlabProps;

function renderLiquidGlass(
  shape: "card" | "pill",
  props: React.ComponentPropsWithoutRef<typeof LiquidGlassSurface> & OnSlabProps,
  ref: React.Ref<HTMLElement>
) {
  const { className, onSlab = false, fill = true, ...rest } = props;

  return (
    <LiquidGlassSurface
      ref={ref}
      fill={fill}
      data-material={shape === "pill" ? "liquid-glass-pill" : "liquid-glass-card"}
      className={cn(
        shape === "pill" ? "app-material-liquid-pill" : "app-material-liquid-card",
        onSlab && "app-glass-on-slab",
        className
      )}
      {...rest}
    />
  );
}

export const WoodPanel = React.forwardRef<HTMLElement, MaterialElementProps>(function WoodPanel(
  { as, className, ...props },
  ref
) {
  const Component = as || "div";

  return (
    <Component
      ref={ref}
      data-material="wood-panel"
      className={cn("app-material-wood-panel", className)}
      {...props}
    />
  );
});

export const LiquidGlassCard = React.forwardRef<HTMLElement, LiquidMaterialProps>(
  function LiquidGlassCard({ className, onSlab, ...props }, ref) {
    return renderLiquidGlass("card", { ...props, fill: true, onSlab, className }, ref);
  }
);

export const LiquidGlassPill = React.forwardRef<HTMLElement, LiquidPillProps>(
  function LiquidGlassPill({ className, fill = true, onSlab, ...props }, ref) {
    return renderLiquidGlass("pill", { ...props, fill, onSlab, className }, ref);
  }
);

export type MaterialChipTone = "neutral" | "success" | "warning" | "muted";

type MaterialChipProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  tone?: MaterialChipTone;
  type?: React.ButtonHTMLAttributes<HTMLButtonElement>["type"];
};

export const MaterialChip = React.forwardRef<HTMLElement, MaterialChipProps>(function MaterialChip(
  { as, className, tone = "neutral", ...props },
  ref
) {
  const Component = as || "span";

  return (
    <Component
      ref={ref}
      data-material="chip"
      data-tone={tone}
      className={cn("app-material-chip", className)}
      {...props}
    />
  );
});
