"use client";

import { useEffect, useRef, useState } from "react";
import { isImeKeyDown } from "@/lib/ime-keydown";
import { NEW_PAGE_TITLE, type PageCreation } from "./page-creation";

/**
 * A page opened with + before anything is written on it. It is kept only here:
 * the page is made once something is written and the writer moves on (leaves a
 * field or the page), so one opened and left empty is not saved anywhere.
 */
export function PageDraft({ creation, layout = "desktop" }: {
  creation: PageCreation;
  layout?: "desktop" | "phone";
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const written = useRef({ title, text });
  written.current = { title, text };
  const open = useRef(true);
  const saving = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);

  const save = () => {
    const name = written.current.title.trim();
    const body = written.current.text.trim();
    if (saving.current || (!name && !body)) return;
    saving.current = true;
    const page = name || NEW_PAGE_TITLE;
    void creation.persist({ title: page, ...(body ? { body: `# ${page}\n\n${body}\n` } : {}) }, () => open.current)
      .then((made) => { saving.current = made; });
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    open.current = true;
    titleInput.current?.focus();
    return () => {
      // Leaving for another page or screen keeps what was written there.
      open.current = false;
      saveRef.current();
    };
  }, []);

  // Closing the tab would lose text no page holds yet.
  useEffect(() => {
    if (!title.trim() && !text.trim()) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [text, title]);

  return (
    <article className={layout === "phone" ? "app-mobile-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-6"
      : "app-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-6 lg:px-12"} data-testid="page-draft"
      onBlur={(event) => {
        // Moving between its title and its text is still writing it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) save();
      }}>
      <div className="mx-auto max-w-3xl">
        <div className={layout === "phone" ? "mb-4 flex pt-3" : "app-band-header mb-4 flex"}>
          <input ref={titleInput} value={title} onChange={(event) => setTitle(event.target.value)}
            aria-label="Page title" data-testid="page-title" placeholder={NEW_PAGE_TITLE}
            onKeyDown={(event) => {
              if (isImeKeyDown(event.nativeEvent)) return;
              if (event.key === "Enter") { event.preventDefault(); textInput.current?.focus(); }
            }}
            className="page-title mr-auto min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-2xl font-black shadow-none outline-none" />
        </div>
        {creation.error && <p className="mb-3 text-sm text-destructive">{creation.error}</p>}
        <textarea ref={textInput} value={text} onChange={(event) => setText(event.target.value)}
          aria-label="Page text" data-testid="page-draft-text" placeholder="Write the current state of this area…"
          className="page-draft-text page-document block min-h-[50vh] w-full resize-none appearance-none border-0 bg-transparent p-0 shadow-none outline-none [field-sizing:content]" />
      </div>
    </article>
  );
}
