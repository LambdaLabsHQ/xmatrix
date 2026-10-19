"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

import { LiquidGlassSurface } from "./liquid-glass-surface";

type MaterialElementProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  disabled?: boolean;
  href?: string;
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


type PaperPopoverProps = MaterialElementProps & {
  /** `ink` writes the surface in the paper's ink: the bar of actions over a selected passage. */
  tone?: "paper" | "ink";
};

/** A menu or small form floating over the paper: a slip of the same paper, or a stroke of its ink, never glass. */
export const PaperPopover = React.forwardRef<HTMLElement, PaperPopoverProps>(function PaperPopover(
  { as, className, tone = "paper", ...props },
  ref
) {
  const Component = as || "div";

  return (
    <Component
      ref={ref}
      data-material="paper-popover"
      data-tone={tone}
      className={cn("app-material-paper-popover", className)}
      {...props}
    />
  );
});
