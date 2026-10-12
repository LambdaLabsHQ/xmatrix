import { Bot, Layers2, PlugZap, SlidersHorizontal, Sparkles, UsersRound } from "lucide-react";
import type { MentionCandidateSection } from "./mention-complete";

const CATEGORY_ICONS = {
  instance: Layers2,
  agent: Bot,
  user: UsersRound,
  app: PlugZap,
  launch: SlidersHorizontal,
  service: Sparkles,
};

/** Category furniture is flat ink inside the composer's single glass surface. */
export function MentionCategoryLabel({ section }: { section: MentionCandidateSection }) {
  const Icon = CATEGORY_ICONS[section.kind];
  return (
    <span className="app-mention-category-label">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{section.label}</span>
      <span className="app-mention-category-count">{section.totalCount}</span>
    </span>
  );
}
