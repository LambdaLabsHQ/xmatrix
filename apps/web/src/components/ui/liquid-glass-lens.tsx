"use client";

import React, { useEffect, useSyncExternalStore } from "react";

/**
 * The lens of the iOS Liquid Glass material: the backdrop bends toward the
 * centre inside a narrow bezel along the rim, and the flat middle stays
 * unbent. The same lens concentrates light at the rim, so the edge is the
 * backdrop's own colour made brighter, never a painted line: Apple's glass
 * "has no inherent color, and instead takes on colors from the content
 * directly behind it" (HIG, Color), and "bends, shapes, and concentrates
 * light" (WWDC25, Meet Liquid Glass).
 *
 * Only Chromium (and so Electron) accepts an SVG `url()` inside
 * `backdrop-filter`; other engines keep the CSS recipe without a lens.
 *
 * Every cost is bounded, unlike the document-wide version this replaces:
 * - a surface opts in by rendering `LiquidGlassSurface` with `fill`; nothing
 *   scans or watches the document;
 * - one shared ResizeObserver reports border-box sizes after layout, so the
 *   lens never reads layout itself;
 * - sizes snap to a quarter pixel, so the map's rim lands on the surface's
 *   own rim (a map rounded 3px wider than its chip left the chip's right cap
 *   unbent and dull); each map is at most MAX_MAP_PIXELS pixels,
 *   stretched onto the surface (a displacement field is smooth, so it scales);
 * - surfaces with the same rounded size and radius share one filter, and a
 *   filter is dropped as soon as its last surface unmounts or resizes away;
 * - at most MAX_LENSES filters exist; further surfaces keep the CSS recipe;
 * - at most MAPS_PER_FRAME maps are drawn per animation frame.
 */

const SIZE_STEP = 0.25;
const MAX_LENSES = 64;
const MAX_MAP_PIXELS = 48_000;
const MAPS_PER_FRAME = 4;
const MIN_SIZE = 16;

/* Defaults mirror liquid-glass.css; a surface can retune them through the
   same custom properties. */
const DEFAULT_BEZEL = 8;
const DEFAULT_THICKNESS = 18;
const DEFAULT_REFRACTION = 1;
const DEFAULT_EDGE_LIGHT = 0.65;

type Lens = {
  id: string;
  key: string;
  width: number;
  height: number;
  map: string;
  scale: number;
  edgeLight: number;
  users: number;
};

type Surface = {
  key: string | null;
  width: number;
  height: number;
};

const lenses = new Map<string, Lens>();
const surfaces = new Map<HTMLElement, Surface>();
const pending = new Set<HTMLElement>();
const listeners = new Set<() => void>();
let snapshot: Lens[] = [];
let frame = 0;
let observer: ResizeObserver | null = null;
let capable: boolean | null = null;

function publish() {
  snapshot = Array.from(lenses.values()).filter((lens) => lens.map);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isLensCapable() {
  if (capable !== null) return capable;
  if (typeof window === "undefined" || typeof CSS === "undefined" || typeof ResizeObserver === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  const chromium = /(Chrome|Chromium|Edg|OPR|Electron)\//.test(ua) && !/\b(Firefox|FxiOS|CriOS|EdgiOS)\//.test(ua);
  const reduced = window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches ?? false;
  capable = chromium && !reduced && CSS.supports("backdrop-filter", 'url("#x") blur(1px)');
  return capable;
}

function snap(value: number) {
  return Math.round(value / SIZE_STEP) * SIZE_STEP;
}

function release(element: HTMLElement, surface: Surface) {
  if (!surface.key) return;
  const lens = lenses.get(surface.key);
  surface.key = null;
  element.style.removeProperty("--app-liquid-lens");
  if (!lens) return;
  lens.users -= 1;
  if (lens.users <= 0) {
    lenses.delete(lens.key);
    publish();
  }
}

function readNumber(style: CSSStyleDeclaration, name: string, fallback: number) {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function measure(element: HTMLElement, surface: Surface) {
  if (!element.isConnected) return;
  const style = getComputedStyle(element);
  const width = snap(surface.width);
  const height = snap(surface.height);
  /* A surface the recipe keeps flat (glass on a slab, a white control on the
     paper) has no backdrop to bend. */
  if (style.backdropFilter === "none" || width < MIN_SIZE || height < MIN_SIZE) {
    release(element, surface);
    return;
  }
  const radius = Math.min(
    Number.parseFloat(style.borderTopLeftRadius) || 0,
    width / 2,
    height / 2
  );
  const bezel = readNumber(style, "--app-liquid-bezel-width", DEFAULT_BEZEL);
  const thickness = readNumber(style, "--app-liquid-glass-thickness", DEFAULT_THICKNESS);
  const refraction = readNumber(style, "--app-liquid-refraction-level", DEFAULT_REFRACTION);
  const edgeLight = readNumber(style, "--app-liquid-edge-light", DEFAULT_EDGE_LIGHT);
  const key = `${width}x${height}r${Math.round(radius)}b${bezel}t${thickness}l${refraction}e${edgeLight}`;
  if (surface.key === key) return;

  release(element, surface);
  let lens = lenses.get(key);
  if (!lens) {
    if (lenses.size >= MAX_LENSES) return;
    lens = {
      id: `xm-lens-${lenses.size}-${hash(key)}`,
      key,
      width,
      height,
      map: "",
      scale: 0,
      edgeLight,
      users: 0,
    };
    lenses.set(key, lens);
    const drawn = drawLensMap(width, height, radius, bezel, thickness * refraction);
    lens.map = drawn.map;
    lens.scale = drawn.scale;
    publish();
  }
  lens.users += 1;
  surface.key = key;
  element.style.setProperty("--app-liquid-lens", `url("#${lens.id}")`);
}

function flush() {
  frame = 0;
  let drawn = 0;
  for (const element of pending) {
    if (drawn >= MAPS_PER_FRAME) break;
    pending.delete(element);
    const surface = surfaces.get(element);
    if (!surface) continue;
    measure(element, surface);
    drawn += 1;
  }
  if (pending.size > 0) schedule();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(flush);
}

function queue(element: HTMLElement) {
  pending.add(element);
  schedule();
}

function sharedObserver() {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const surface = surfaces.get(element);
      const box = entry.borderBoxSize?.[0];
      if (!surface || !box) continue;
      surface.width = box.inlineSize;
      surface.height = box.blockSize;
      queue(element);
    }
  });
  return observer;
}

/** `version` changes when the surface's lens parameters do, so it redraws. */
export function useLiquidGlassLens(ref: React.RefObject<HTMLElement | null>, enabled: boolean, version = "") {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || !isLensCapable()) return;
    const surface: Surface = { key: null, width: 0, height: 0 };
    surfaces.set(element, surface);
    sharedObserver().observe(element);
    return () => {
      observer?.unobserve(element);
      pending.delete(element);
      surfaces.delete(element);
      release(element, surface);
    };
  }, [ref, enabled, version]);
}

/** Rendered once, from the root layout. */
export function LiquidGlassLensDefs() {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  if (current.length === 0) return null;
  return (
    <svg
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
      aria-hidden="true"
    >
      <defs>
        {current.map((lens) => (
          <filter
            key={lens.key}
            id={lens.id}
            x="0"
            y="0"
            width={lens.width}
            height={lens.height}
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              href={lens.map}
              x="0"
              y="0"
              width={lens.width}
              height={lens.height}
              preserveAspectRatio="none"
              result="LENS"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="LENS"
              scale={lens.scale}
              xChannelSelector="R"
              yChannelSelector="G"
              result="BENT"
            />
            {/* The map's blue channel is the light the rim concentrates. Spread
                to grey and scaled by edgeLight, it screens the bent backdrop
                (bent + light − bent · light): the backdrop's own colour, paler. */}
            <feColorMatrix
              in="LENS"
              type="matrix"
              values={`0 0 ${lens.edgeLight} 0 0 0 0 ${lens.edgeLight} 0 0 0 0 ${lens.edgeLight} 0 0 0 0 0 0 1`}
              result="LIGHT"
            />
            <feComposite in="BENT" in2="LIGHT" operator="arithmetic" k1={-1} k2={1} k3={1} k4={0} />
          </filter>
        ))}
      </defs>
    </svg>
  );
}

/* ---- the map -------------------------------------------------------------

   Each pixel inside the bezel samples the backdrop further toward the centre,
   by thickness · (1 − d/bezel)² at distance d from the rim. Fitted against
   Apple's iOS 26 Phone screenshot: the offset stays large across the outer
   few pixels, so content just inside the rim folds out to the edge as a thin
   mirrored arc, apart from the content itself. (A Snell squircle, kube.io's
   profile, collapses that band into one pixel; a circle profile magnifies
   the whole disc.) Encoding: r = 128 + dx·127, g = 128 + dy·127, normalised
   to the largest offset, which becomes the feDisplacementMap scale.

   The blue channel is the light concentrated at the rim: a crisp line about
   1pt wide (exp(−d/0.8) at distance d px from the edge), brightest where the
   edge faces a light from the top left and, weaker, on the opposite edge, as
   in Apple's iOS 26 screenshots; the sides between catch only a little. The
   filter screens the backdrop with edgeLight · blue / 255 of white, which is
   how Apple's rims measure (the backdrop moved 30-45% toward white at the lit
   edge): over wood the rim is a paler wood, and over white it is invisible. */

const PROFILE = Array.from({ length: 128 }, (_, i) => (1 - i / 127) ** 2);
const RIM_FALLOFF = 0.8;
const LIGHT_X = -Math.SQRT1_2;
const LIGHT_Y = -Math.SQRT1_2;
const RIM_AMBIENT = 0.2;
const RIM_LEAD = 0.8;
const RIM_TRAIL = 0.4;

/* Glass only shows what is behind it: every bent sample stays this far inside
   the shape, clear of the blur's dark edge. On a 20px chip a deep lens would
   otherwise read past the far edge and paint a black line along the rim. */
const SAMPLE_MARGIN = 3;

function insideDistance(x: number, y: number, halfWidth: number, halfHeight: number, r: number) {
  const qx = Math.abs(x) - (halfWidth - r);
  const qy = Math.abs(y) - (halfHeight - r);
  return -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r);
}

function rimLight(distance: number, normalX: number, normalY: number) {
  const facing = normalX * LIGHT_X + normalY * LIGHT_Y;
  const lit = RIM_AMBIENT + RIM_LEAD * Math.max(0, facing) ** 2 + RIM_TRAIL * Math.max(0, -facing) ** 2;
  return Math.exp(-distance / RIM_FALLOFF) * lit;
}

function drawLensMap(width: number, height: number, radius: number, bezelWidth: number, thickness: number) {
  const scaleDown = Math.min(1, Math.sqrt(MAX_MAP_PIXELS / (width * height)));
  const mapWidth = Math.max(1, Math.round(width * scaleDown));
  const mapHeight = Math.max(1, Math.round(height * scaleDown));
  const canvas = document.createElement("canvas");
  canvas.width = mapWidth;
  canvas.height = mapHeight;
  const context = canvas.getContext("2d");
  if (!context) return { map: "", scale: 0 };
  const image = context.createImageData(mapWidth, mapHeight);
  const data = image.data;
  const bezel = Math.max(1, Math.min(bezelWidth, width / 2, height / 2));
  const r = Math.min(radius, width / 2, height / 2);
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  for (let my = 0; my < mapHeight; my += 1) {
    for (let mx = 0; mx < mapWidth; mx += 1) {
      const index = (my * mapWidth + mx) * 4;
      data[index] = 128;
      data[index + 1] = 128;
      data[index + 2] = 0;
      data[index + 3] = 255;
      const px = ((mx + 0.5) / mapWidth) * width - halfWidth;
      const py = ((my + 0.5) / mapHeight) * height - halfHeight;
      const qx = Math.abs(px) - (halfWidth - r);
      const qy = Math.abs(py) - (halfHeight - r);
      const distance = insideDistance(px, py, halfWidth, halfHeight, r);
      if (distance <= 0 || distance >= bezel) continue;
      let ox = 0;
      let oy = 0;
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy) || 1;
        ox = qx / length;
        oy = qy / length;
      } else if (qx > qy) {
        ox = 1;
      } else {
        oy = 1;
      }
      ox *= Math.sign(px) || 1;
      oy *= Math.sign(py) || 1;
      let offset = (PROFILE[Math.round((distance / bezel) * (PROFILE.length - 1))] ?? 0) * thickness;
      while (offset > 0 && insideDistance(px - ox * offset, py - oy * offset, halfWidth, halfHeight, r) < SAMPLE_MARGIN) {
        offset -= 0.5;
      }
      const magnitude = thickness > 0 ? Math.max(0, offset) / thickness : 0;
      data[index] = 128 - ox * magnitude * 127;
      data[index + 1] = 128 - oy * magnitude * 127;
      data[index + 2] = Math.min(255, Math.round(rimLight(distance, ox, oy) * 255));
    }
  }

  context.putImageData(image, 0, 0);
  return { map: canvas.toDataURL("image/png"), scale: Math.round(thickness * 2 * 100) / 100 };
}

function hash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
