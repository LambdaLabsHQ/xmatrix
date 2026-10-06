"use client";


/**
 * Shared, bounded SVG definitions used by the CSS material recipes.
 *
 * Keep this component static. A previous Chromium-only implementation watched
 * the complete document, synchronously measured every glass surface, generated
 * two full-size PNG maps for every distinct element size, and installed a
 * separate backdrop filter on each element. Normal responsive-size variation
 * made both the cache and compositor work unbounded; a modest group of glass
 * surfaces could block Chromium (and therefore Electron) for minutes.
 *
 * The visual system already has a CSS blur/saturation fallback. These small
 * shared filters preserve the named references used by older material rules
 * without layout reads, observers, pointer listeners, or per-element bitmaps.
 */
export function LiquidGlassFilter() {
  return (
    <svg
      style={{
        position: "absolute",
        width: 0,
        height: 0,
        overflow: "hidden",
        pointerEvents: "none",
      }}
      aria-hidden="true"
    >
      <defs>
        <filter id="xm-liquid-glass" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="0.45" />
        </filter>
        <filter id="xm-liquid-lens" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="0.25" />
        </filter>
        <filter id="xm-liquid-edgeglass" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="0.2" />
        </filter>
      </defs>
    </svg>
  );
}
