import { Plus } from "lucide-react";
import { landingCopy, type Locale } from "@/lib/landing-copy";

export function Faq({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].faq;
  return (
    <section id="faq" className="x-section">
      <div className="x-container">
        <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
          {copy.title}
        </h2>
        <div className="mt-10 max-w-3xl divide-y divide-foreground/10 border-y border-foreground/10">
          {copy.questions.map(([question, answer]) => (
            <details key={question} className="site-faq group py-5">
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
