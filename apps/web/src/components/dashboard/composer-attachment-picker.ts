import type {
  DesktopBridge,
  NativeAttachmentPickerSource,
} from "@/lib/desktop/bridge";

export const NATIVE_ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024;

export const COMPOSER_ATTACHMENT_SOURCES: readonly NativeAttachmentPickerSource[] = [
  "photos",
  "camera",
  "files",
];

export type AttachmentPanelKeyStep =
  | { active: number; pick?: undefined }
  | { active: null; pick?: undefined }
  | { active: null; pick: NativeAttachmentPickerSource };

/**
 * Keyboard navigation for the attachment panel while it is morphed open inside
 * the composer capsule. Returns null when the key does not belong to the menu.
 */
export function attachmentPanelKey(input: {
  open: boolean;
  active: number;
  key: string;
}): AttachmentPanelKeyStep | null {
  if (!input.open) return null;
  const count = COMPOSER_ATTACHMENT_SOURCES.length;
  if (input.key === "Escape") return { active: null };
  if (input.key === "ArrowUp") {
    return { active: input.active < 0 ? count - 1 : (input.active - 1 + count) % count };
  }
  if (input.key === "ArrowDown") {
    return { active: input.active < 0 ? 0 : (input.active + 1) % count };
  }
  if (input.key === "Enter" && input.active >= 0 && input.active < count) {
    return { active: null, pick: COMPOSER_ATTACHMENT_SOURCES[input.active] };
  }
  return null;
}

function decodeBase64Chunk(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Reads files selected through the native iOS picker bridge in bounded chunks
 * so large videos never cross WebKit's IPC boundary as one giant base64 blob.
 */
export async function loadNativePickedAttachments(
  bridge: Pick<DesktopBridge, "pickAttachments" | "readPickedAttachmentChunk" | "releasePickedAttachment">,
  source: NativeAttachmentPickerSource,
  maxBytes: number,
  maxBytesLabel: string,
  chunkBytes = NATIVE_ATTACHMENT_CHUNK_BYTES,
): Promise<File[]> {
  if (!bridge.pickAttachments || !bridge.readPickedAttachmentChunk) {
    return [];
  }
  const picked = await bridge.pickAttachments({ source });
  if (!Array.isArray(picked) || picked.length === 0) return [];

  const files: File[] = [];
  try {
    for (const item of picked) {
      if (item.size > maxBytes) {
        throw new Error(`File must be ${maxBytesLabel} or smaller.`);
      }
      const parts: BlobPart[] = [];
      let offset = 0;
      const readCap = Math.max(0, Math.min(item.size, maxBytes));
      while (offset < readCap) {
        const length = Math.min(chunkBytes, readCap - offset);
        const chunk = await bridge.readPickedAttachmentChunk({
          token: item.token,
          offset,
          length,
        });
        if (chunk.dataBase64) {
          parts.push(decodeBase64Chunk(chunk.dataBase64));
        }
        if (chunk.eof) break;
        if (!Number.isFinite(chunk.bytesRead) || chunk.bytesRead <= 0) {
          throw new Error("Could not read the selected file.");
        }
        offset += chunk.bytesRead;
      }
      files.push(
        new File(parts, item.name || "attachment", {
          type: item.mimeType || "application/octet-stream",
        })
      );
    }
    return files;
  } finally {
    if (bridge.releasePickedAttachment) {
      await Promise.allSettled(
        picked.map((item) => bridge.releasePickedAttachment!({ token: item.token }))
      );
    }
  }
}
