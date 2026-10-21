"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { faceOfPageAuthor, pageAuthorColor, type FaceOf } from "@xmatrix/protocol";
import { useFace } from "@/components/dashboard/face";
import { avatarImageSrc } from "@/components/dashboard/identity-avatar";
import { useAuth } from "@/lib/auth-context";
import { pageApi } from "@/lib/pages/page-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import type { PageSuggestion } from "./page-suggestions";

// Keep the editor's suggestions effect idle while no suggestions are waiting.
const NONE_WAITING: readonly PageSuggestion[] = [];
/** No one: what the face in front is read as while no suggestion waits, a face that needs no read. */
const NO_FACE: FaceOf = { kind: "machine", name: "" };

/**
 * The suggestions waiting on a page (pages-live-document.md §4.2), each with the text it was proposed
 * against, so the editor can lay it over the page as it is now. Revisions never change, so a
 * suggestion's texts are read once; the list is read again when the session says one arrived.
 */
export function usePageSuggestions(spaceId: string | null, pageId: string | null, token: string, enabled: boolean) {
  const { user } = useAuth();
  const key = xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-suggestions", [spaceId ?? "", pageId ?? ""]);
  const list = useQuery({
    queryKey: key, enabled: enabled && Boolean(spaceId && pageId && token),
    queryFn: ({ signal }) => pageApi.suggestions(spaceId!, pageId!, token, signal),
  });
  const waiting = list.data?.suggestions ?? [];
  const texts = useQuery({
    queryKey: [...key, "texts", waiting.map((suggestion) => suggestion.revision).join(",")],
    enabled: waiting.length > 0, staleTime: Infinity,
    queryFn: ({ signal }) => Promise.all(waiting.map(async (suggestion): Promise<PageSuggestion> => {
      const [base, body] = await Promise.all([
        pageApi.read(spaceId!, pageId!, token, suggestion.basedOnRevision ?? suggestion.revision - 1, signal),
        pageApi.read(spaceId!, pageId!, token, suggestion.revision, signal),
      ]);
      const author = suggestion.authors.find((entry) => entry.kind === "agent") ?? suggestion.authors[0];
      return { revision: suggestion.revision, base: base.page.body, body: body.page.body, author: author?.label ?? "",
        color: author ? pageAuthorColor(author) : "", face: author ? faceOfPageAuthor(author) : NO_FACE };
    })),
  });
  const suggestions = waiting.length === 0 ? NONE_WAITING : texts.data ?? null;
  // The change in front of the reader is the last suggestion's: its face rides the pen in the line.
  const face = suggestions?.at(-1)?.face ?? null;
  const drawn = useFace(face ?? NO_FACE);
  const faceUrl = face ? avatarImageSrc(drawn.imageUrl) : undefined;
  const withPen = useMemo(() => suggestions && suggestions.length > 0 && faceUrl
    ? suggestions.map((suggestion, index) => index === suggestions.length - 1 ? { ...suggestion, faceUrl } : suggestion)
    : suggestions, [faceUrl, suggestions]);
  return {
    /** Null while the texts are read; empty when nothing waits. */
    suggestions: withPen,
    /** Whose change is in front of the reader, by their face; null when none waits. */
    face,
    /** The last suggestion a review of all of them covers. */
    through: waiting.reduce((last, suggestion) => Math.max(last, suggestion.revision), 0),
    refetch: () => void list.refetch(),
  };
}
