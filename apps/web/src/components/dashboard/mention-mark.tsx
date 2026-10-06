import { AtSign } from "lucide-react";

import { statusInkClass } from "@/components/ui/status-tone";

/** An unread @ on a conversation row, on a phone as on a desktop. */
export function MentionMark() {
  return (
    <span className="inline-flex shrink-0" aria-label="Unread mention" title="Unread mention">
      <AtSign className={statusInkClass("attention", "size-3.5")} aria-hidden="true" />
    </span>
  );
}
