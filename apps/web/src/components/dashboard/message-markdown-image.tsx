"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { ImageGalleryLightbox } from "./attachment-lightbox";
import { LoadingImage } from "./content-skeleton";

/** An image written into a message's Markdown (an Agent's screenshot, a chart): inline at
    its own size, and opened in the image viewer by a click, where it can be zoomed and panned.
    An image that is the content of a link stays a link. */
export function MessageMarkdownImage({ src, alt }: { src: string; alt: string }) {
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const [linked, setLinked] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    setLinked(Boolean(frameRef.current?.closest("a")));
  }, []);

  const image = <LoadingImage src={src} alt={alt} className="max-h-[28rem] max-w-full object-contain" />;
  if (linked) {
    return <span ref={frameRef} className="mt-2 inline-block max-w-full align-top">{image}</span>;
  }
  return (
    <>
      <span
        ref={frameRef}
        role="button"
        tabIndex={0}
        aria-label={alt ? `Open ${alt}` : "Open image"}
        className="message-markdown-image mt-2 inline-block max-w-full cursor-zoom-in align-top"
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {image}
      </span>
      {open && (
        <ImageGalleryLightbox
          images={[{ id: src, name: alt || "Image", src }]}
          activeId={src}
          onActiveChange={() => undefined}
          onClose={() => setOpen(false)}
          originFor={() => frameRef.current?.querySelector("img") ?? null}
        />
      )}
    </>
  );
}
