import type { NativeAttachmentPickerSource } from "@/lib/desktop/bridge";

const COMPOSER_ATTACHMENT_SOURCES: readonly NativeAttachmentPickerSource[] = [
  "photos",
  "camera",
  "files",
];

/** Maximum age of an armed one-shot source before `runOpenPanelWith` treats it as stale. */
const PENDING_ATTACHMENT_SOURCE_TTL_MS = 5000;

type PendingAttachmentSourceRecord = {
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
function armNativeAttachmentSource(
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
  ownerId: string;
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
    ownerId?: string;
    mounted: boolean;
    generation: number;
    draftRevision: number;
    scope: string | null;
    requireOrigin?: boolean;
  },
): boolean {
  if (!current.mounted) return false;
  if (!origin) return !current.requireOrigin;
  if (current.ownerId !== undefined && origin.ownerId !== current.ownerId) return false;
  return (
    origin.generation === current.generation &&
    origin.draftRevision === current.draftRevision &&
    origin.scope === current.scope
  );
}

type ActiveNativePanelRequest = {
  origin: DraftPickOrigin;
  deliver: (files: FileList | null, origin: DraftPickOrigin) => void;
};

let activeNativePanel: ActiveNativePanelRequest | null = null;
let sharedNativeFileInput: HTMLInputElement | null = null;
const panelListeners = new Set<() => void>();

function notifyNativePanelListeners() {
  for (const listener of panelListeners) listener();
}

function settleActiveNativePanel(files: FileList | null) {
  const request = activeNativePanel;
  activeNativePanel = null;
  clearPendingAttachmentSource();
  notifyNativePanelListeners();
  if (request && files && files.length > 0) {
    request.deliver(files, request.origin);
  }
}

function ensureSharedNativeFileInput(): HTMLInputElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (sharedNativeFileInput && sharedNativeFileInput.isConnected) {
    return sharedNativeFileInput;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.style.display = "none";
  input.addEventListener("change", () => {
    const files = input.files;
    settleActiveNativePanel(files);
    input.value = "";
  });
  input.addEventListener("cancel", () => {
    settleActiveNativePanel(null);
    input.value = "";
  });
  document.body.appendChild(input);
  sharedNativeFileInput = input;
  return input;
}

export function subscribeNativeAttachmentPanel(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

/**
 * Returns the currently active page-wide native open-panel origin, or null when
 * idle. WebKit enforces one open panel per WKWebView page, so every Composer
 * observes this single state rather than keeping isolated per-instance locks.
 */
export function getActiveNativeAttachmentPanel(): DraftPickOrigin | null {
  return activeNativePanel?.origin ?? null;
}

/**
 * Opens a native iOS open panel through one document-level `<input type="file">`
 * that outlives individual Composer mounts (e.g. closing New Conversation while
 * iCloud downloads), ensuring `change`/`cancel` always settles and unlocks later
 * composers while rejecting stale files from unmounted or switched drafts.
 */
export function openNativeAttachmentPanel(input: {
  source?: NativeAttachmentPickerSource;
  multiple?: boolean;
  accept?: string;
  origin: DraftPickOrigin;
  deliver: (files: FileList | null, origin: DraftPickOrigin) => void;
}): boolean {
  if (activeNativePanel) return false;
  const element = ensureSharedNativeFileInput();
  if (!element) return false;
  activeNativePanel = { origin: input.origin, deliver: input.deliver };
  notifyNativePanelListeners();
  element.multiple = input.multiple ?? true;
  element.accept = input.accept ?? "";
  if (input.source) armNativeAttachmentSource(input.source);
  else clearPendingAttachmentSource();
  element.click();
  return true;
}
