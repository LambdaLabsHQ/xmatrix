export type ImageDimensions = {
  width: number;
  height: number;
};

function isValidDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function safeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

/** Keeps an image's aspect ratio while fitting its longest edge in `maxDimension`. */
export function fitImageDimensions(
  dimensions: ImageDimensions,
  maxDimension: number,
): ImageDimensions {
  const width = safeDimension(dimensions.width);
  const height = safeDimension(dimensions.height);
  const longestEdge = Math.max(width, height);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0 || longestEdge <= maxDimension) {
    return { width, height };
  }

  const scale = maxDimension / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Estimate the next JPEG dimensions from the previous encoded size. JPEG sizes
 * are approximately proportional to pixel count, so this avoids repeatedly
 * re-encoding the same large bitmap with small, fixed reductions.
 */
export function nextImageCompressionDimensions(input: {
  dimensions: ImageDimensions;
  encodedBytes: number;
  targetBytes: number;
}): ImageDimensions {
  const dimensions = {
    width: safeDimension(input.dimensions.width),
    height: safeDimension(input.dimensions.height),
  };
  if (
    !Number.isFinite(input.encodedBytes) ||
    !Number.isFinite(input.targetBytes) ||
    input.encodedBytes <= input.targetBytes ||
    input.targetBytes <= 0
  ) {
    return dimensions;
  }

  // Leave a little headroom for JPEG entropy variance. The bounds avoid one
  // drastic visual-quality drop while ensuring oversized images converge fast.
  const scale = Math.max(0.5, Math.min(0.98, Math.sqrt(input.targetBytes / input.encodedBytes) * 0.96));
  const width = Math.max(1, Math.round(dimensions.width * scale));
  const height = Math.max(1, Math.round(dimensions.height * scale));
  if (width < dimensions.width || height < dimensions.height) return { width, height };

  return {
    width: Math.max(1, dimensions.width - 1),
    height: Math.max(1, dimensions.height - 1),
  };
}

/**
 * Read dimensions from the inexpensive image container header. This lets the
 * bitmap decoder downsize a large source while it decodes, instead of decoding
 * the full bitmap and only then shrinking it on a canvas.
 */
export function encodedImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes);
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return isValidDimension(width) && isValidDimension(height) ? { width, height } : null;
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) return null;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return isValidDimension(width) && isValidDimension(height) ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 20 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (size > bytes.length - dataStart) return null;
    if (kind === "VP8X" && size >= 10) {
      const width = 1 + readUint24LE(bytes, dataStart + 4);
      const height = 1 + readUint24LE(bytes, dataStart + 7);
      return isValidDimension(width) && isValidDimension(height) ? { width, height } : null;
    }
    if (kind === "VP8 " && size >= 10 && bytes[dataStart + 3] === 0x9d && bytes[dataStart + 4] === 0x01 && bytes[dataStart + 5] === 0x2a) {
      const width = (bytes[dataStart + 6] | (bytes[dataStart + 7] << 8)) & 0x3fff;
      const height = (bytes[dataStart + 8] | (bytes[dataStart + 9] << 8)) & 0x3fff;
      return isValidDimension(width) && isValidDimension(height) ? { width, height } : null;
    }
    if (kind === "VP8L" && size >= 5 && bytes[dataStart] === 0x2f) {
      const packed = view.getUint32(dataStart + 1, true);
      const width = 1 + (packed & 0x3fff);
      const height = 1 + ((packed >>> 14) & 0x3fff);
      return isValidDimension(width) && isValidDimension(height) ? { width, height } : null;
    }
    offset = dataStart + size + (size % 2);
  }
  return null;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
