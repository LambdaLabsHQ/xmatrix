import table from "./media-types.json" with { type: "json" };

/**
 * One file type xMatrix names by extension (media-types.json, which the CLI
 * reads too): its MIME type, its extensions (the first is the one a saved copy
 * gets) and where it shows inline.
 */
interface MediaTypeEntry {
  type: string;
  aliases?: string[];
  extensions: string[];
  /** Shown inline in a conversation and handed to a model as an image. */
  image?: boolean;
  /** Shown inline in a page. */
  page?: boolean;
}

/** How a conversation draws an attachment. */
export type AttachmentKind = "image" | "video" | "markdown" | "file";

const ENTRIES: readonly MediaTypeEntry[] = table.types;
const BY_EXTENSION = new Map(ENTRIES.flatMap((entry) => entry.extensions.map((extension) => [extension, entry] as const)));
const BY_TYPE = new Map(ENTRIES.flatMap((entry) => [entry.type, ...entry.aliases ?? []].map((type) => [type, entry] as const)));
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

/** `type/subtype`, lower case and without parameters; empty when it is not one. */
function bareType(mimeType: string): string {
  const type = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return MIME_TYPE.test(type) ? type : "";
}

/** The type a file name's extension names; undefined for an extension no entry lists. */
export function mediaTypeForName(name: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase();
  return extension ? BY_EXTENSION.get(extension)?.type : undefined;
}

/**
 * The type of a file stated as `mimeType` and named `name`. A specific stated
 * type wins, including a non-media one; a generic or missing one is read from
 * the name; anything else is `application/octet-stream`.
 */
export function mediaTypeOf(mimeType: string, name = ""): string {
  const stated = bareType(mimeType);
  if (!GENERIC_TYPES.has(stated)) return BY_TYPE.get(stated)?.type ?? stated;
  return mediaTypeForName(name) ?? "application/octet-stream";
}

/** The extension a saved copy of `mimeType` gets; undefined for a type no entry lists. */
export function extensionForMediaType(mimeType: string): string | undefined {
  return BY_TYPE.get(bareType(mimeType))?.extensions[0];
}

/** Whether a file of this type and name plays as video or audio. */
export function playableMediaKind(mimeType: string, name = ""): "video" | "audio" | null {
  const type = mediaTypeOf(mimeType, name);
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return null;
}

/** How a conversation draws a file of this type and name. */
export function attachmentKind(mimeType: string, name = ""): AttachmentKind {
  const type = mediaTypeOf(mimeType, name);
  if (BY_TYPE.get(type)?.image) return "image";
  if (type.startsWith("video/")) return "video";
  if (type === "text/markdown") return "markdown";
  return "file";
}

/** What a page shows inline, by the extension its reference carries. */
export const PAGE_MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  ENTRIES.filter((entry) => entry.page).flatMap((entry) => entry.extensions.map((extension) => [extension, entry.type])),
));
