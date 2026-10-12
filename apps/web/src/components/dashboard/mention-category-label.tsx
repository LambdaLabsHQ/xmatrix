import { Bot, Layers2, PlugZap, SlidersHorizontal, Sparkles, UsersRound } from "lucide-react";
import { ListSectionLabel, type ListSectionMark } from "./list-section-heading";
import type { MentionCandidateSection } from "./mention-complete";

const CATEGORY_MARKS: Record<MentionCandidateSection["kind"], ListSectionMark> = {
  instance: { icon: Layers2, tone: "primary" },
  agent: { icon: Bot, tone: "agent" },
  user: { icon: UsersRound, tone: "human" },
  app: { icon: PlugZap, tone: "app" },
  launch: { icon: SlidersHorizontal, tone: "plain" },
  service: { icon: Sparkles, tone: "plain" },
};

/** A category is named by the lists' coloured section label, so it never reads as a choice. */
export function MentionCategoryLabel({ section }: { section: MentionCandidateSection }) {
  return <ListSectionLabel label={section.label} count={section.totalCount} mark={CATEGORY_MARKS[section.kind]} />;
}
