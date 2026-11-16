import { playableMediaKind } from "@xmatrix/protocol";

/** Whether a plain HTTPS link names a file that plays as video or audio. */
export function directMediaLink(href: string): "video" | "audio" | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return playableMediaKind("", decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
}
