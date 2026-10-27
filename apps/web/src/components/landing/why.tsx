import Image from "next/image";
import { landingCopy, type Locale } from "@/lib/landing-copy";


/**
 * xMatrix beside juggling agent tools, row by row, on two pieces of tinted
 * paper like the app's asks and choices: no rule, no rim, no shadow. On a
 * wide screen each side is one sheet from its name to the last row and a row
 * deepens on both sheets under the pointer; on a phone each topic is one
 * two-tone piece, the xMatrix line over the other.
 */
export function Why({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].why;
  return (
    <section id="why" className="x-section">
      <div className="x-container">
        <h2 className="site-display text-center text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
          {copy.title}
        </h2>
        <div className="site-why mx-auto mt-14 flex max-w-5xl flex-wrap gap-x-2 gap-y-7 md:grid md:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-[repeat(7,auto)_0.5rem] md:gap-x-3 md:gap-y-0">
          <div aria-hidden className="site-why-sheet site-why-ours hidden md:col-start-2 md:row-span-full md:block" />
          <div aria-hidden className="site-why-sheet site-why-theirs hidden md:col-start-3 md:row-span-full md:block" />
          <p className="site-why-ours site-why-name flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold md:rounded-none md:col-start-2 md:row-start-1 md:px-7 md:pt-7 md:pb-3 md:text-lg">
            <Image src="/brand/xmatrix-icon-transparent-128.png" alt="" width={24} height={24} className="size-4 md:size-6" />
            xMatrix
          </p>
          <p className="site-why-theirs site-why-name rounded-full px-3 py-1 text-sm font-semibold md:rounded-none md:col-start-3 md:row-start-1 md:px-7 md:pt-7 md:pb-3 md:text-lg">
            {copy.others}
          </p>
          {copy.rows.map(([topic, ours, theirs], index) => (
            <div key={topic} className="site-why-row w-full md:col-[1/-1] md:grid md:grid-cols-subgrid" style={{ gridRow: index + 2 }}>
              <h3 className="mb-2.5 text-sm leading-6 font-semibold text-foreground md:mb-0 md:py-4 md:pr-6">{topic}</h3>
              <p className="site-why-ours site-why-cell rounded-t-[14px] px-4 pt-3.5 pb-3 text-[0.9375rem] leading-6 md:mx-2 md:rounded-[12px] md:px-5 md:py-4">
                <span className="site-why-ink block">{ours}</span>
              </p>
              <p className="site-why-theirs site-why-cell rounded-b-[14px] px-4 pt-3 pb-3.5 text-sm leading-6 md:mx-2 md:rounded-[12px] md:px-5 md:py-4 md:text-[0.9375rem]">
                {theirs}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
