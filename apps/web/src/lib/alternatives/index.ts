import { adjacentPlatformEntries } from "./adjacent-platforms";
import { controlPlaneEntries } from "./control-planes";
import { directCompetitorEntries } from "./direct-competitors";
import type { AlternativeEntry, AlternativePage } from "./types";

export type { AlternativePage } from "./types";

const ROUTE_SUFFIX = "-alternatives";

const allEntries: readonly AlternativeEntry[] = [
  ...directCompetitorEntries,
  ...controlPlaneEntries,
  ...adjacentPlatformEntries,
];

export const alternativePages: readonly AlternativePage[] = allEntries.map((entry) => {
  const routeSlug = `${entry.slug}${ROUTE_SUFFIX}`;
  return {
    ...entry,
    routeSlug,
    href: `/${routeSlug}`,
  };
});

/** Legacy product names that redirect permanently to the current competitor page. */
const legacyRouteRedirects: Readonly<Record<string, string>> = {
  "superset-alternatives": "/paradev-alternatives",
  "slock-alternatives": "/raft-alternatives",
  "lobechat-alternatives": "/lobehub-alternatives",
  "evermemos-alternatives": "/everos-alternatives",
  "google-jules-alternatives": "/jules-alternatives",
};

const bySlug = new Map<string, AlternativePage>(alternativePages.map((page) => [page.slug, page]));
const byRouteSlug = new Map<string, AlternativePage>(alternativePages.map((page) => [page.routeSlug, page]));

export function findAlternativePageByRouteSlug(routeSlug: string): AlternativePage | undefined {
  return byRouteSlug.get(routeSlug);
}

export function findAlternativeRedirect(routeSlug: string): string | undefined {
  return legacyRouteRedirects[routeSlug];
}

export function relatedAlternatives(page: AlternativePage): AlternativePage[] {
  return page.relatedSlugs
    .map((slug) => bySlug.get(slug))
    .filter((entry): entry is AlternativePage => Boolean(entry));
}
