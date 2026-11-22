import { adjacentPlatformEntries } from "./adjacent-platforms";
import { controlPlaneEntries } from "./control-planes";
import { directCompetitorEntries } from "./direct-competitors";
import type { AlternativeCategory, AlternativeCategoryId, AlternativeEntry, AlternativePage } from "./types";

export type { AlternativePage } from "./types";

export const alternativeCategories: readonly AlternativeCategory[] = [
  {
    id: "workspaces",
    label: "Multi-Agent Team Workspaces",
    description:
      "Workspaces built to coordinate multiple coding agents and teammates—where the tradeoffs come down to living Pages, permissions, pricing, and staying online.",
  },
  {
    id: "control-planes",
    label: "Local Control Planes & Terminals",
    description:
      "Solo multi-harness launchers, agent terminals, and first-party desktop apps—great for one developer until you need multiplayer identity, living docs, or cross-vendor quota handoff.",
  },
  {
    id: "platforms",
    label: "Adjacent Platforms, Memory Layers & Sunsetting Tools",
    description:
      "Issue trackers, wiki agents, chat APIs, passive memory stores, and cloud coding agents facing credit traps, API throttling, or permanent shutdowns.",
  },
];

const allEntries: readonly AlternativeEntry[] = [
  ...directCompetitorEntries,
  ...controlPlaneEntries,
  ...adjacentPlatformEntries,
];

export const alternativePages: readonly AlternativePage[] = allEntries.map((entry) => ({
  ...entry,
  href: `/alternatives/${entry.slug}`,
}));

const bySlug = new Map<string, AlternativePage>(alternativePages.map((page) => [page.slug, page]));

export function findAlternativePage(slug: string): AlternativePage | undefined {
  return bySlug.get(slug);
}

export function alternativePagesByCategory(category: AlternativeCategoryId): AlternativePage[] {
  return alternativePages.filter((page) => page.category === category);
}

export function relatedAlternatives(page: AlternativePage): AlternativePage[] {
  return page.relatedSlugs
    .map((slug) => bySlug.get(slug))
    .filter((entry): entry is AlternativePage => Boolean(entry));
}
