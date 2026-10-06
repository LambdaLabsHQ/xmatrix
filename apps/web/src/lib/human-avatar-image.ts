import {
  HUMAN_AVATAR_EDGE_PX,
  HUMAN_AVATAR_MAX_BYTES,
  HUMAN_AVATAR_MIME_TYPES,
  humanAvatarMimeType,
  type HumanAvatarMimeType,
} from "@xmatrix/protocol";

/**
 * Turns whatever a person picked into the one shape an avatar is: a square,
 * bounded, re-encoded image. Decoding and rendering are separate steps because
 * the crop dialog sits between them — the person frames the square, then the
 * chosen rect is rendered.
 *
 * Re-encoding is the point, not a size optimisation. A camera photo carries
 * EXIF, which routinely includes GPS coordinates, and an avatar is the most
 * widely-published thing in the product. Drawing to a canvas and re-encoding
 * keeps the pixels and drops everything else. A Worker has no image decoder,
 * so this is the only place in the pipeline where that can happen — the server
 * validates and stores, it cannot sanitise.
 */
export const HUMAN_AVATAR_ACCEPT = HUMAN_AVATAR_MIME_TYPES.join(",");

export type AvatarSource = {
  image: ImageBitmap | HTMLImageElement;
  /** EXIF-oriented pixels: what the person sees, not what the file stores. */
  width: number;
  height: number;
};

export type PreparedAvatar = {
  blob: Blob;
  mimeType: HumanAvatarMimeType;
  /** Object URL for an immediate preview; the caller revokes it. */
  previewUrl: string;
};

export class AvatarImageError extends Error {
  constructor(readonly code: "avatar_type_unsupported" | "avatar_decode_failed" | "avatar_too_large", message: string) {
    super(message);
    this.name = "AvatarImageError";
  }
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      // Honour the orientation a phone recorded in EXIF; the canvas draw below
      // discards the tag, so ignoring it here would bake in a sideways face.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the <img> path rather than failing a decodable file.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new AvatarImageError("avatar_decode_failed", "Could not read that image."));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function decodeAvatarSource(file: File): Promise<AvatarSource> {
  if (!humanAvatarMimeType(file.type)) {
    throw new AvatarImageError("avatar_type_unsupported", "Choose a PNG, JPEG, or WebP image.");
  }
  const image = await decode(file);
  const width = "width" in image ? image.width : 0;
  const height = "height" in image ? image.height : 0;
  if (!width || !height) {
    throw new AvatarImageError("avatar_decode_failed", "Could not read that image.");
  }
  return { image, width, height };
}

export function releaseAvatarSource(source: AvatarSource): void {
  if ("close" in source.image && typeof source.image.close === "function") source.image.close();
}

function encode(canvas: HTMLCanvasElement, mimeType: HumanAvatarMimeType): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, 0.9));
}

/**
 * Render the chosen square of the source into the avatar. The rect arrives in
 * source pixels from view math and may carry float drift, so it is snapped and
 * clamped to the image here rather than trusted. Output never upscales past
 * the source: a small crop stays small instead of being inflated to 512.
 */
export async function renderAvatarCrop(
  source: AvatarSource,
  rect: { x: number; y: number; edge: number },
): Promise<PreparedAvatar> {
  const edge = Math.max(1, Math.min(Math.round(rect.edge), Math.min(source.width, source.height)));
  const x = Math.min(Math.max(0, Math.round(rect.x)), source.width - edge);
  const y = Math.min(Math.max(0, Math.round(rect.y)), source.height - edge);
  const target = Math.max(1, Math.min(HUMAN_AVATAR_EDGE_PX, edge));

  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const context = canvas.getContext("2d");
  if (!context) throw new AvatarImageError("avatar_decode_failed", "Could not read that image.");
  context.drawImage(source.image, x, y, edge, edge, 0, 0, target, target);

  /* WebP first: it is the smallest of the three at equal quality and every
     browser that can run this app encodes it. PNG is the fallback because
     `toBlob` silently substitutes it when a type is unsupported, so accepting
     whatever came back — and reading its real type — beats asserting. */
  const encoded = (await encode(canvas, "image/webp")) ?? (await encode(canvas, "image/png"));
  if (!encoded) throw new AvatarImageError("avatar_decode_failed", "Could not read that image.");
  const mimeType = humanAvatarMimeType(encoded.type);
  if (!mimeType) {
    throw new AvatarImageError("avatar_type_unsupported", "Could not encode that image.");
  }
  if (encoded.size > HUMAN_AVATAR_MAX_BYTES) {
    // Only reachable for pathological content at 512px; say so plainly rather
    // than retrying at a quality the person did not choose.
    throw new AvatarImageError("avatar_too_large", "That image is too large after resizing.");
  }

  return { blob: encoded, mimeType, previewUrl: URL.createObjectURL(encoded) };
}
