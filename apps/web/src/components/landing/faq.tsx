import { Plus } from "lucide-react";
import { SPLIT, SectionIntro } from "@/components/landing/section-intro";
import { landingCopy, type Locale } from "@/lib/landing-copy";

export function Faq({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].faq;
  return (
    <section id="faq" className="x-section">
      <div className={`x-container ${SPLIT}`}>
        <SectionIntro title={copy.title} />
        {/* Each question is a slip of tinted paper that opens in place; spacing, not rules, sets them apart. */}
        <div className="grid gap-2">
          {copy.questions.map(([question, answer]) => (
            <details key={question} className="site-faq group rounded-[0.875rem] bg-[color-mix(in_oklch,var(--site-ink)_4.5%,var(--background))] px-5 py-[1.125rem]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-base font-semibold text-foreground">
                {question}
                <Plus className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-45" aria-hidden />
              </summary>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
