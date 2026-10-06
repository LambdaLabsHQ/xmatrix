"use client";

import { useState, type ReactNode } from "react";
import { directMediaLink } from "./attachment-media-type";

/** Uses the host browser's decoder, including Chromium in the Electron shell. */
export function MediaPlayer({ kind, src, name, poster, className, autoPlay = false }: {
  kind: "video" | "audio";
  src: string;
  name: string;
  poster?: string;
  className?: string;
  autoPlay?: boolean;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (failedSource === src) {
    return <span role="status" className="flex h-full min-h-16 items-center justify-center bg-muted p-3 text-sm text-muted-foreground">
      This media could not be played. Download it or open the original link.
    </span>;
  }
  const props = {
    src, controls: true, preload: "metadata", autoPlay,
    "aria-label": name,
    onError: () => setFailedSource(src),
  };
  return kind === "video"
    ? <video key={src} {...props} poster={poster} playsInline className={className} />
    : <audio key={src} {...props} className="w-full" />;
}

/** External media is contacted only when the reader explicitly opens its preview. */
export function MediaLink({ href, children }: { href: string; children: ReactNode }) {
  const [openedHref, setOpenedHref] = useState<string | null>(null);
  const opened = openedHref === href;
  const kind = directMediaLink(href);
  return <span className="inline-block max-w-full align-top">
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2">{children}</a>
    {kind && <>
      <button type="button" className="ml-2 text-xs text-primary underline" aria-expanded={opened} onClick={() => setOpenedHref(opened ? null : href)}>
        {opened ? "Close media" : "Preview media"}
      </button>
      {opened && <span className="mt-2 block max-w-full">
        <MediaPlayer kind={kind} src={href} name="Linked media" className="max-h-[28rem] max-w-full bg-black object-contain" />
      </span>}
    </>}
  </span>;
}
