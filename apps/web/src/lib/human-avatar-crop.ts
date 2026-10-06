/**
 * Geometry for the avatar crop view: the picked image is shown at `scale`
 * with its top-left at (`offsetX`, `offsetY`) inside a square viewport, and
 * the circle inscribed in that viewport is the future avatar. Dragging moves
 * the offsets, the slider moves the scale, and every change passes through
 * the same clamp so the circle can never leave the image.
 *
 * Pure math, kept apart from the canvas work, so the clamps hold without a
 * browser.
 */
export type AvatarCropView = {
  /** Source image size in EXIF-oriented pixels. */
  width: number;
  height: number;
  /** Edge of the square viewport, in the same units as the offsets. */
  viewport: number;
  /** Displayed pixels per source pixel. */
  scale: number;
  offsetX: number;
  offsetY: number;
};

/** The smallest scale that still covers the viewport — fully zoomed out. */
export function minCropScale(view: Pick<AvatarCropView, "width" | "height" | "viewport">): number {
  return view.viewport / Math.min(view.width, view.height);
}

/** Four times cover: past that the crop is a handful of source pixels. */
export function maxCropScale(view: Pick<AvatarCropView, "width" | "height" | "viewport">): number {
  return minCropScale(view) * 4;
}

/** An offset may never open a gap: the image must keep covering the viewport. */
function clampOffset(offset: number, scaledExtent: number, viewport: number): number {
  return Math.min(0, Math.max(viewport - scaledExtent, offset));
}

export function clampCropView(view: AvatarCropView): AvatarCropView {
  const scale = Math.min(maxCropScale(view), Math.max(minCropScale(view), view.scale));
  return {
    ...view,
    scale,
    offsetX: clampOffset(view.offsetX, view.width * scale, view.viewport),
    offsetY: clampOffset(view.offsetY, view.height * scale, view.viewport),
  };
}

/** Fully zoomed out and centred — the same framing the old automatic crop chose. */
export function initialCropView(width: number, height: number, viewport: number): AvatarCropView {
  const scale = minCropScale({ width, height, viewport });
  return clampCropView({
    width,
    height,
    viewport,
    scale,
    offsetX: (viewport - width * scale) / 2,
    offsetY: (viewport - height * scale) / 2,
  });
}

/** Change scale while the point under the viewport centre stays put. */
export function zoomCropView(view: AvatarCropView, nextScale: number): AvatarCropView {
  const scale = Math.min(maxCropScale(view), Math.max(minCropScale(view), nextScale));
  const centre = view.viewport / 2;
  return clampCropView({
    ...view,
    scale,
    offsetX: centre - ((centre - view.offsetX) / view.scale) * scale,
    offsetY: centre - ((centre - view.offsetY) / view.scale) * scale,
  });
}

/** The viewport square mapped back to source pixels — what actually gets cropped. */
export function cropRectFromView(view: AvatarCropView): { x: number; y: number; edge: number } {
  return {
    x: -view.offsetX / view.scale,
    y: -view.offsetY / view.scale,
    edge: view.viewport / view.scale,
  };
}
