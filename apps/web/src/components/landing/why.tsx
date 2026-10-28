import Image from "next/image";
import { WHY_SCENES } from "@/components/landing/why-scenes";
import { landingCopy, type Locale } from "@/lib/landing-copy";


/**
 * xMatrix beside juggling agent tools, row by row. Each side of a row is a
 * piece of tinted paper, as in the app's asks and choices (no rule, no rim,
 * no shadow), holding a small playing example above its line: xMatrix on
 * the warm piece, juggling agent tools on the plain one.
 */
export function Why({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].why;
  return (
    <section id="why" className="x-section">
      <div className="x-container">
        <h2 className="site-display text-center text-3xl font-semibold text-foreground sm:text-5xl lg:text-4xl xl:text-5xl">
          {copy.title}
        </h2>
        <div className="site-why mx-auto mt-14 grid max-w-5xl grid-cols-2 gap-x-2 gap-y-8 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)] md:gap-x-3 md:gap-y-3">
          <p className="site-why-name site-why-ours flex items-center gap-2 justify-self-start rounded-full px-3 py-1 text-sm font-semibold md:col-start-2 md:justify-self-stretch md:rounded-none md:bg-transparent md:px-1 md:text-lg">
            <Image src="/brand/xmatrix-icon-transparent-128.png" alt="" width={24} height={24} className="size-4 md:size-6" />
            xMatrix
          </p>
          <p className="site-why-name site-why-theirs justify-self-start rounded-full px-3 py-1 text-sm font-semibold md:justify-self-stretch md:rounded-none md:bg-transparent md:px-1 md:text-lg">
            {copy.others}
          </p>
          {copy.rows.map(([topic, ours, theirs], index) => {
            const [oursScene, theirsScene] = WHY_SCENES[index]!;
            return (
              <div key={topic} className="col-span-2 grid gap-2 md:col-span-3 md:grid-cols-subgrid md:gap-x-3 md:gap-y-0">
                <h3 className="text-sm leading-6 font-semibold text-foreground md:pt-4 md:pr-4">{topic}</h3>
                <figure className="site-why-panel site-why-ours">
                  <div className="site-why-scene" aria-hidden>{oursScene(copy.scenes)}</div>
                  <figcaption className="site-why-caption">{ours}</figcaption>
                </figure>
                <figure className="site-why-panel site-why-theirs">
                  <div className="site-why-scene" aria-hidden>{theirsScene(copy.scenes)}</div>
                  <figcaption className="site-why-caption">{theirs}</figcaption>
                </figure>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
