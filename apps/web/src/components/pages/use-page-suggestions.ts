"use client";

import { useQuery } from "@tanstack/react-query";
import { agentPresetAvatarUrl, normalizeAgentPresetRuntime, pageAuthorColor } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { pageApi } from "@/lib/pages/page-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import type { PageSuggestion } from "./page-suggestions";

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
      const avatarUrl = author?.kind === "agent"
        ? agentPresetAvatarUrl(normalizeAgentPresetRuntime(author.label.split(":")[0])) : undefined;
      return { revision: suggestion.revision, base: base.page.body, body: body.page.body, author: author?.label ?? "",
        color: author ? pageAuthorColor(author) : "", ...(avatarUrl ? { avatarUrl } : {}) };
    })),
  });
  return {
    /** Null while the texts are read; empty when nothing waits. */
    suggestions: waiting.length === 0 ? [] : texts.data ?? null,
    /** The last suggestion a review of all of them covers. */
    through: waiting.reduce((last, suggestion) => Math.max(last, suggestion.revision), 0),
    refetch: () => void list.refetch(),
  };
}
