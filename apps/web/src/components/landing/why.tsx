import Image from "next/image";
import { Check, Minus } from "lucide-react";
import { landingCopy, type Locale } from "@/lib/landing-copy";


/**
 * xMatrix beside juggling agent tools, row by row. On a wide screen the
 * xMatrix column is one sheet of paper from its name to the last row, so the
 * column itself says which side is which, and its lines are written in as the
 * table scrolls into view; on a phone each topic stacks both answers under
 * one hairline.
 */
export function Why({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].why;
  return (
    <section id="why" className="x-section">
      <div className="x-container">
        <h2 className="site-display text-center text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
          {copy.title}
        </h2>
        <div className="site-why mx-auto mt-14 flex max-w-5xl flex-col md:grid md:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-[repeat(7,auto)]">
          <div aria-hidden className="site-paper-sheet hidden md:col-start-2 md:row-span-full md:block" />
          <p className="hidden items-center gap-2.5 px-7 pt-7 pb-5 text-lg font-semibold text-foreground md:col-start-2 md:row-start-1 md:flex">
            <Image src="/brand/xmatrix-icon-transparent-128.png" alt="" width={24} height={24} />xMatrix
          </p>
          <p className="hidden px-7 pt-7 pb-5 text-lg font-semibold text-muted-foreground md:col-start-3 md:row-start-1 md:block">{copy.others}</p>
          {copy.rows.map(([topic, ours, theirs], index) => {
            const row = { gridRow: index + 2 };
            return (
            <div key={topic} className={`site-why-row py-5 md:contents ${index ? "border-t" : "pt-0"}`}>
              <h3 style={row} className="text-sm font-semibold text-foreground md:col-start-1 md:border-t md:py-5 md:pr-6">{topic}</h3>
              <p style={row} className="site-why-ours mt-2 flex gap-2.5 text-[0.9375rem] leading-6 md:col-start-2 md:mx-7 md:mt-0 md:border-t md:py-5">
                <Check className="mt-1 size-4 shrink-0 md:hidden" aria-label="xMatrix" />{ours}
              </p>
              <p style={row} className="mt-1.5 flex gap-2.5 text-sm leading-6 text-muted-foreground md:col-start-3 md:mt-0 md:border-t md:px-7 md:py-5 md:text-[0.9375rem]">
                <Minus className="mt-1 size-4 shrink-0 md:hidden" aria-label={copy.others} />{theirs}
              </p>
            </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
