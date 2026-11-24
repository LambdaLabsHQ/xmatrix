import type { ReactNode } from "react";

/* One heading size and one sentence size for every section. A Chinese or
   Japanese heading breaks between phrases, not inside one: at punctuation, a
   space, or a zero-width space in the copy (landing-copy.ts); only a phrase
   wider than the line breaks anywhere. */
const TITLE = "site-display text-[clamp(2rem,1.3rem_+_2.2vw,3rem)] font-semibold leading-[1.1] text-[var(--site-ink)] break-keep wrap-anywhere";
const LEAD = "max-w-[34rem] text-lg leading-[1.65] text-[var(--site-ink-muted)]";

/** A section's heading and the sentence under it. */
export function SectionIntro({ title, body, id }: { title: string; body?: string; id?: string }) {
  return (
    <div className="grid max-w-[46rem] gap-[1.125rem]">
      <h2 id={id} className={TITLE}>{title}</h2>
      {body && <p className={LEAD}>{body}</p>}
    </div>
  );
}

/**
 * The heading over a stage, where the product itself is shown: the heading on
 * the left, its sentence on the right with its first line on the heading's,
 * and whatever belongs with the sentence beneath it.
 */
export function StageCaption({ id, title, body, children }: { id: string; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="mb-[clamp(2rem,4vw,3.5rem)] grid gap-4 lg:grid-cols-2 lg:items-start lg:gap-x-16">
      <h2 id={id} className={TITLE}>{title}</h2>
      <div className="grid justify-items-start gap-7 lg:pt-[0.6rem]">
        <p className={LEAD}>{body}</p>
        {children}
      </div>
    </div>
  );
}

/** A section whose content is narrow keeps its heading beside it: pricing, questions. */
export const SPLIT = "grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-x-16";
