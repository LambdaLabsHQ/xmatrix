import type { MentionCandidateSection } from "./mention-complete";

/** A caption, not a choice: quiet text with no icon, so it never reads as a row. */
export function MentionCategoryLabel({ section }: { section: MentionCandidateSection }) {
  return (
    <span className="app-mention-category-label">
      <span>{section.label}</span>
      <span className="app-mention-category-count">{section.totalCount}</span>
    </span>
  );
}
