import { withRoute, type PublicPage } from "@xmatrix/protocol";
import { getXMatrixHubUrl } from "@/lib/xmatrix";

export type PublicPagePresent = { name: string; color: string; kind: "user" | "agent"; activity: string | null };

/**
 * A published page as anyone reads it, fetched by the Next server so the page
 * is rendered for search engines and link previews; null when it is not public.
 */
export async function loadPublicPage(spaceId: string, pageId: string):
  Promise<{ page: PublicPage; present: PublicPagePresent[] } | null> {
  const route = `/api/public/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`;
  const response = await fetch(withRoute(serverHubUrl(), route), { next: { revalidate: 10 } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`public page unavailable (${response.status})`);
  return response.json() as Promise<{ page: PublicPage; present: PublicPagePresent[] }>;
}

/** The browser e2e fixture build has no Hub; its server reads a stand-in the spec serves. */
function serverHubUrl(): string {
  return process.env.NEXT_PUBLIC_XMATRIX_E2E_COMPATIBILITY_FIXTURE === "1" && process.env.XMATRIX_E2E_SERVER_HUB_URL
    ? process.env.XMATRIX_E2E_SERVER_HUB_URL : getXMatrixHubUrl();
}
