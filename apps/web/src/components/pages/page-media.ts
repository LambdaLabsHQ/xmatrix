import { PAGE_MEDIA_TYPES, pageMediaReference, parsePageMedia } from "@xmatrix/protocol";
import { RELAY_V2_MESSAGE_ATTACHMENT_UPLOAD_MAX_BYTES } from "@xmatrix/protocol/relay-v2/message-attachment";
import { pageSchema } from "@xmatrix/protocol/page-document";
import { Fragment, Slice, type Node as DocNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { sha256Blob } from "@/lib/relay-v2/message-attachment-upload-client";
import {
  dropOwnedMedia, pageMediaOwnKey, pageMediaOwnSpec, releasePageMedia, rememberOwnedImages, retainPageMedia,
  type LocalMedia,
} from "./page-media-own";

export type { LocalMedia };

/**
 * Images and videos pasted or dropped into a page. The file is uploaded into
 * the Space's private storage and the page's text gets a markdown image,
 * `![name](xmatrix:page-media/<sha-256>.<ext>)`; the page draws it from the
 * Hub, as whoever reads it, and a video as a player.
 */

/** Where the page reads a file it shows (`<sha-256>.<ext>`); none when it cannot be read here. */
export type PageMediaUrl = (file: string) => string | undefined;

/** Uploads a file into the page and keeps it there; rejects with what went wrong. */
export type UploadPageMedia = (file: File, onProgress: (percent: number) => void) => Promise<void>;

/** One reading a page's media is drawn from, local files first. */
export interface PageMediaSource {
  url: PageMediaUrl;
  local?: (file: string) => LocalMedia | undefined;
}

const SHOWN_TYPES = new Set<string>(Object.values(PAGE_MEDIA_TYPES));
/** A file another writer has only just pasted is still uploading; it is read again a few times. */
const UNSAVED_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

/**
 * The element a page shows a file as: an image, or a video with its controls.
 * A file not readable yet is tried again, a bounded number of times.
 */
export function pageMediaElement(src: string, alt: string, source: PageMediaSource | undefined): HTMLElement | null {
  const media = parsePageMedia(src);
  if (!media) return null;
  const frame = document.createElement("span");
  frame.className = "page-media";
  frame.contentEditable = "false";
  frame.dataset.testid = "page-media";
  const element = media.video ? document.createElement("video") : document.createElement("img");
  if (element instanceof HTMLVideoElement) {
    element.controls = true;
    element.preload = "metadata";
    element.playsInline = true;
    if (alt) element.title = alt;
  } else {
    element.alt = alt;
    element.draggable = false;
  }
  frame.append(element);
  const local = source?.local?.(media.file);
  const remote = source?.url(media.file);
  if (local) {
    element.src = local.url;
    const progress = () => {
      if (local.progress === null) delete frame.dataset.uploading;
      else frame.dataset.uploading = String(local.progress);
    };
    progress();
    local.listeners.add(progress);
  } else if (remote) {
    let attempt = 0;
    frame.dataset.state = "loading";
    const loaded = () => { frame.dataset.state = "ready"; };
    element.addEventListener(element instanceof HTMLVideoElement ? "loadedmetadata" : "load", loaded);
    element.addEventListener("error", () => {
      const delay = UNSAVED_RETRY_MS[attempt++];
      if (delay === undefined || !frame.isConnected) {
        frame.dataset.state = "missing";
        return;
      }
      window.setTimeout(() => {
        if (frame.isConnected) element.src = `${remote}?attempt=${attempt}`;
      }, delay);
    });
    element.src = remote;
  } else {
    frame.dataset.state = "missing";
  }
  return frame;
}

/** An image node as the page draws it: its pasted file from the Hub, any other image as written. */
class ImageView implements NodeView {
  dom: HTMLElement;

  constructor(private node: DocNode, source: PageMediaSource | undefined) {
    const src = node.attrs.src as string;
    const alt = node.attrs.alt as string;
    this.dom = pageMediaElement(src, alt, source) ?? Object.assign(document.createElement("img"),
      { src, alt, ...(node.attrs.title ? { title: node.attrs.title as string } : {}) });
  }

  update(node: DocNode) {
    return node.type === this.node.type && node.attrs.src === this.node.attrs.src && node.attrs.alt === this.node.attrs.alt
      && node.attrs.title === this.node.attrs.title;
  }

  /** A video's controls are its own. */
  stopEvent(event: Event) {
    return event.target instanceof HTMLVideoElement;
  }

  ignoreMutation() {
    return true;
  }
}

export function imageView(source: () => PageMediaSource | undefined): (node: DocNode) => NodeView {
  return (node: DocNode) => new ImageView(node, source());
}

function mediaFiles(data: DataTransfer | null): File[] {
  return [...data?.files ?? []].filter((file) => SHOWN_TYPES.has(file.type));
}

/**
 * Pasting or dropping images and videos uploads them into the page: each is in
 * the text at once, drawn from the writer's own copy until it has uploaded.
 * A file that does not upload leaves the text again, and `onFailure` says why.
 */
export function pageMediaPaste(input: {
  upload: () => UploadPageMedia | undefined;
  local: Map<string, LocalMedia>;
  onFailure: (message: string) => void;
}): Plugin {
  const insert = async (view: EditorView, files: File[], at: number | null) => {
    const upload = input.upload();
    if (!upload) return;
    const accepted = files.filter((file) => {
      if (file.size <= RELAY_V2_MESSAGE_ATTACHMENT_UPLOAD_MAX_BYTES) return true;
      input.onFailure(`${file.name || "The file"} is larger than ${RELAY_V2_MESSAGE_ATTACHMENT_UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
      return false;
    });
    const placed = await Promise.all(accepted.map(async (file) => {
      const contentHash = await sha256Blob(file);
      const src = pageMediaReference(contentHash, file.type)!;
      const name = parsePageMedia(src)!.file;
      // One preview per file. A second paste of a file already on the page shares it,
      // and a failure of that paste must not revoke the preview the first one still shows.
      const local = retainPageMedia(input.local, name, () => URL.createObjectURL(file));
      return { id: crypto.randomUUID(), file, src, local, name };
    }));
    const releasePlaced = () => {
      for (const item of placed) releasePageMedia(input.local, item.name, item.local, URL.revokeObjectURL);
    };
    if (!placed.length || view.isDestroyed) {
      releasePlaced();
      return;
    }
    const content = Fragment.from(placed.map(({ file, src }) => pageSchema.nodes.image.create({ src, alt: file.name || "" })));
    const selection = { from: view.state.selection.from, to: view.state.selection.to };
    const insertAt = at === null ? null : Math.min(at, view.state.doc.content.size);
    const tr = insertAt === null ? view.state.tr.replaceSelection(new Slice(content, 0, 0))
      : view.state.tr.insert(insertAt, content);
    rememberOwnedImages(tr, insertAt === null ? selection : { from: insertAt, to: insertAt }, placed);
    view.dispatch(tr.scrollIntoView());
    for (const { id, file, local, name } of placed) {
      const report = (progress: number | null) => {
        local.progress = progress;
        for (const listener of local.listeners) listener();
      };
      upload(file, report).then(() => {
        // The preview stays: the node is still drawn from this copy. Its holder is released with the editor.
        report(null);
        local.listeners.clear();
      }, (error: unknown) => {
        input.onFailure(`${file.name || "The file"} could not be uploaded${
          error instanceof Error && error.message ? `: ${error.message}` : "."}`);
        if (!view.isDestroyed) view.dispatch(dropOwnedMedia(view.state, id));
        releasePageMedia(input.local, name, local, URL.revokeObjectURL);
      });
    }
  };
  const unread = () => input.onFailure("The file could not be read.");
  return new Plugin({
    key: pageMediaOwnKey,
    state: pageMediaOwnSpec(),
    props: {
      handlePaste(view, event) {
        const files = mediaFiles(event.clipboardData);
        if (!files.length || !view.editable || view.state.selection.$from.parent.type.spec.code) return false;
        // Copying files can also copy their names as text; any other text is what is pasted.
        const text = event.clipboardData?.getData("text/plain").trim() ?? "";
        const names = new Set(files.map((file) => file.name));
        if (text && !text.split(/\r?\n/u).every((line) => names.has(line.trim()))) return false;
        event.preventDefault();
        insert(view, files, null).catch(unread);
        return true;
      },
      handleDrop(view, event) {
        const files = mediaFiles((event as DragEvent).dataTransfer);
        if (!files.length || !view.editable) return false;
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
        if (!at) return false;
        event.preventDefault();
        insert(view, files, at.pos).catch(unread);
        return true;
      },
    },
  });
}
