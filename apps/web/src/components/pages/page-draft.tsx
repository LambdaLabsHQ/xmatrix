"use client";

import { useEffect, useRef, useState } from "react";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { Button } from "@/components/ui/button";
import { keepCoWriteRequest } from "@/lib/pages/co-write-request";
import { isImeKeyDown } from "@/lib/ime-keydown";
import { NEW_PAGE_TITLE, type PageCreation } from "./page-creation";
import { PagePhoneDock } from "./page-phone-dock";
import { PageWriteWith } from "./page-write-with";
import { usePageWriters } from "./page-writers";

/**
 * A page opened with + before anything is written on it. It is kept only here:
 * the page is made once something is written and the writer moves on (leaves a
 * field or the page), so one opened and left empty is not saved anywhere.
 * Co-writing starts here as on any page: calling an Agent makes the page and
 * opens it with that Agent called (co-write-request.ts).
 */
export function PageDraft({ creation, spaceId, token, layout = "desktop" }: {
  creation: PageCreation;
  spaceId: string | null;
  token: string;
  layout?: "desktop" | "phone";
}) {
  const writers = usePageWriters(spaceId, token, true);
  const [choosing, setChoosing] = useState(false);
  const [calling, setCalling] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const written = useRef({ title, text });
  written.current = { title, text };
  const open = useRef(true);
  const saving = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);

  /** Makes the page once something is written on it, or at once to co-write it with `harness`. */
  const save = (harness?: string) => {
    const name = written.current.title.trim();
    const body = written.current.text.trim();
    if (saving.current || (!harness && !name && !body)) return;
    saving.current = true;
    const page = name || NEW_PAGE_TITLE;
    void creation.persist({ title: page, ...(body ? { body: `# ${page}\n\n${body}\n` } : {}) }, () => open.current,
      harness ? (pageId) => keepCoWriteRequest(pageId, harness) : undefined)
      .then((made) => {
        saving.current = made;
        if (!made && harness) setCalling(null);
      });
  };
  const coWrite = (harness: string) => {
    setChoosing(false);
    setCalling(harness);
    writers.choose(harness);
    save(harness);
  };
  const favourite = writers.agents.find((agent) => agent.harness === calling) ?? writers.agents[0];
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
    <div className="relative flex min-h-0 min-w-0 flex-1" onBlur={(event) => {
      // Moving between its title and its text is still writing it, as is choosing an Agent to write it with.
      if (!choosing && !event.currentTarget.contains(event.relatedTarget as Node | null)) save();
    }}>
      <article className={layout === "phone" ? "app-mobile-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-6"
        : "app-page-article min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-6 lg:px-12"} data-testid="page-draft">
        <div className="mx-auto max-w-3xl">
          <div className={layout === "phone" ? "mb-4 flex pt-3" : "app-band-header mb-4 flex items-center gap-1.5"}>
            <input ref={titleInput} value={title} onChange={(event) => setTitle(event.target.value)}
              aria-label="Page title" data-testid="page-title" placeholder={NEW_PAGE_TITLE}
              onKeyDown={(event) => {
                if (isImeKeyDown(event.nativeEvent)) return;
                if (event.key === "Enter") { event.preventDefault(); textInput.current?.focus(); }
              }}
              className="page-title mr-auto min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-2xl font-black shadow-none outline-none" />
            {layout !== "phone" && favourite && (
              <Button variant="ghost" size="sm" onClick={() => setChoosing(true)} title={`Co-write with ${favourite.harness}`}
                disabled={creation.creating || calling !== null}>
                <IdentityAvatar kind="agent" label={favourite.harness} imageUrl={favourite.avatarUrl} size="xs"
                  shape="circle" glass={false} className="pointer-events-none rounded-full" />
                Co-write
              </Button>
            )}
          </div>
          {creation.error && <p className="mb-3 text-sm text-destructive">{creation.error}</p>}
          <textarea ref={textInput} value={text} onChange={(event) => setText(event.target.value)}
            aria-label="Page text" data-testid="page-draft-text" placeholder="Write the current state of this area…"
            className="page-draft-text page-document block min-h-[50vh] w-full resize-none appearance-none border-0 bg-transparent p-0 shadow-none outline-none [field-sizing:content]" />
        </div>
      </article>
      {layout === "phone" && (
        <PagePhoneDock caller={favourite ? { name: favourite.harness, ...(favourite.avatarUrl ? { avatarUrl: favourite.avatarUrl } : {}) }
          : null} starting={calling !== null} onCall={() => { if (!calling) setChoosing(true); }} />
      )}
      {choosing && (
        <PageWriteWith agents={writers.agents} working={null} onStart={coWrite} onOpenConversation={null}
          onClose={() => setChoosing(false)} />
      )}
    </div>
  );
}
