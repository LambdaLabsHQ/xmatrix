import type { CSSProperties } from "react";

/**
 * The tunable physics of the one liquid-glass recipe (liquid-glass.css).
 *
 * Every field maps to one of the recipe's custom properties, so a value set
 * here reaches the fill, the backdrop chain and the lens alike. Set it on one
 * surface through the `material` prop of LiquidGlassSurface / LiquidGlassPill
 * / LiquidGlassCard, or on a container through `liquidGlassMaterialStyle`, so
 * every glass surface inside takes it. A background (the wood rail, a plank)
 * never sets one: glass is the same on wood as on the paper. Unset fields
 * keep the surrounding context's value, and in the end the recipe's own
 * defaults, listed on each field.
 */
export type LiquidGlassMaterial = {
  /** The veil laid over the bent backdrop, Apple's luminosity lift. Default `oklch(0.97 0 0 / 0.4)`. */
  veil?: string;
  /** Gaussian blur before the lens, in px. Default 2. */
  blur?: number;
  /** Saturation after the lens. Default 1.5. */
  saturation?: number;
  /** Largest lens offset at the rim, in px. Default 18. */
  refraction?: number;
  /** Width of the band along the rim that bends, in px. Default 8. */
  bezel?: number;
  /** How far the lens screens the rim toward white, 0-1. Default .65. */
  edgeLight?: number;
  /** Shadow cast under the glass. Defaults: `0 10px 30px` at .14, a third of that for chips and avatars. */
  shadow?: LiquidGlassShadow | "none";
};

export type LiquidGlassShadow = {
  /** Vertical offset, in px. */
  y: number;
  /** Blur radius, in px. */
  blur: number;
  /** Black at this opacity, 0-1. */
  opacity: number;
};

function shadowValue(shadow: LiquidGlassShadow | "none") {
  return shadow === "none" ? "0 0 0 0 transparent" : `0 ${shadow.y}px ${shadow.blur}px oklch(0 0 0 / ${shadow.opacity})`;
}

/** The custom properties that carry `material`; spread into a `style`. */
export function liquidGlassMaterialStyle(material: LiquidGlassMaterial | undefined): CSSProperties | undefined {
  if (!material) return undefined;
  const style: Record<string, string> = {};
  if (material.veil !== undefined) {
    style["--app-liquid-surface-bg"] = material.veil;
    style["--app-liquid-shared-surface-bg"] = material.veil;
  }
  if (material.blur !== undefined) style["--app-liquid-material"] = `blur(${material.blur}px)`;
  if (material.saturation !== undefined) style["--app-liquid-vibrancy"] = `saturate(${material.saturation})`;
  if (material.refraction !== undefined) style["--app-liquid-glass-thickness"] = String(material.refraction);
  if (material.bezel !== undefined) style["--app-liquid-bezel-width"] = String(material.bezel);
  if (material.edgeLight !== undefined) style["--app-liquid-edge-light"] = String(material.edgeLight);
  if (material.shadow !== undefined) {
    const shadow = shadowValue(material.shadow);
    style["--app-liquid-shadow"] = shadow;
    style["--app-liquid-shadow-small"] = shadow;
    style["--app-glass-edge"] = `var(--app-liquid-rim-layers), ${shadow}`;
  }
  return style as CSSProperties;
}

/** Changes whenever a field the lens draws from changes, so the surface redraws its lens. */
export function liquidGlassLensVersion(material: LiquidGlassMaterial | undefined) {
  return material ? `${material.refraction ?? ""}/${material.bezel ?? ""}/${material.edgeLight ?? ""}` : "";
}
