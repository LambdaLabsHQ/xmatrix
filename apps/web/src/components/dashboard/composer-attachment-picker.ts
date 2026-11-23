import type { NativeAttachmentPickerSource } from "@/lib/desktop/bridge";

export const COMPOSER_ATTACHMENT_SOURCES: readonly NativeAttachmentPickerSource[] = [
  "photos",
  "camera",
  "files",
];

/** Maximum age of an armed one-shot source before `runOpenPanelWith` treats it as stale. */
export const PENDING_ATTACHMENT_SOURCE_TTL_MS = 5000;

export type PendingAttachmentSourceRecord = {
  source: NativeAttachmentPickerSource;
  expiresAt: number;
};

declare global {
  interface Window {
    __xmatrixPendingAttachmentSource?: PendingAttachmentSourceRecord | null;
  }
}

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

/**
 * Arms a one-shot attachment source synchronously before `fileInput.click()` so
 * iOS `WKUIDelegate.webView(_:runOpenPanelWith:...)` can atomically read and
 * clear it without losing transient user activation across an async boundary.
 */
export function armNativeAttachmentSource(
  source: NativeAttachmentPickerSource,
  now = Date.now(),
): PendingAttachmentSourceRecord {
  const record: PendingAttachmentSourceRecord = {
    source,
    expiresAt: now + PENDING_ATTACHMENT_SOURCE_TTL_MS,
  };
  if (typeof window !== "undefined") {
    window.__xmatrixPendingAttachmentSource = record;
  }
  return record;
}

export function clearPendingAttachmentSource(): void {
  if (typeof window !== "undefined") {
    window.__xmatrixPendingAttachmentSource = null;
  }
}

export type DraftPickOrigin = {
  generation: number;
  draftRevision: number;
  scope: string | null;
};

/**
 * Returns true only when an async picker or file-input selection still belongs
 * to the draft that opened it (guards A→B, A→B→A, sending the draft meanwhile,
 * and closing the thread/composer).
 */
export function isDraftPickCurrent(
  origin: DraftPickOrigin | null,
  current: {
    mounted: boolean;
    generation: number;
    draftRevision: number;
    scope: string | null;
    requireOrigin?: boolean;
  },
): boolean {
  if (!current.mounted) return false;
  if (!origin) return !current.requireOrigin;
  return (
    origin.generation === current.generation &&
    origin.draftRevision === current.draftRevision &&
    origin.scope === current.scope
  );
}
