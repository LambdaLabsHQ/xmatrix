/** Presentation hints only; immutable attachment metadata remains authoritative. */
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  webm: "video/webm", mp4: "video/mp4", m4v: "video/x-m4v",
  mov: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska",
  avi: "video/x-msvideo", mpg: "video/mpeg", mpeg: "video/mpeg",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
  wav: "audio/wav", flac: "audio/flac", oga: "audio/ogg",
  ogg: "audio/ogg", opus: "audio/ogg", weba: "audio/webm",
};

export function attachmentMediaMimeType(mimeType: string, name = ""): string {
  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  // A specific MIME wins over a filename, including non-media types.
  if (mime && mime !== "application/octet-stream" && mime !== "binary/octet-stream") return mime;
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return (extension && MEDIA_EXTENSIONS[extension]) || mime || "application/octet-stream";
}

export function attachmentMediaType(mimeType: string, name = ""): "video" | "audio" | null {
  const mime = attachmentMediaMimeType(mimeType, name);
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

export function directMediaLink(href: string): "video" | "audio" | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return attachmentMediaType("", decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}
