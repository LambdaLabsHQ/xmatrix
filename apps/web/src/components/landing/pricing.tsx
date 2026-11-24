"use client";

import { Check } from "lucide-react";
import { SPLIT, SectionIntro } from "@/components/landing/section-intro";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { landingCopy, type Locale } from "@/lib/landing-copy";
import { appHref } from "@/lib/site-url";

export function Pricing({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].pricing;
  const plans = [
    { name: "Free", price: "$0", period: "", ...copy.free, href: appHref("/login"), highlighted: false },
    { name: "Pro", price: "$10", ...copy.pro, href: appHref("/login?next=%2Fbilling"), highlighted: true },
  ];
  return (
    <section id="pricing" className="x-section">
      <div className={`x-container ${SPLIT}`}>
        <div>
          <SectionIntro title={copy.title} body={copy.body} />
          <p className="mt-6 max-w-[34rem] text-xs leading-[1.65] text-[var(--site-ink-muted)]">
            {copy.terms}{" "}
            <a className="underline underline-offset-4" href={copy.xCreditsLink.href}>{copy.xCreditsLink.label}</a>
          </p>
        </div>

        <div className="x-mobile-card-scroller grid min-w-0 gap-4 md:grid-cols-2">
          {plans.map(({ name, price, period, description, features, href, highlighted }) => {
            // The plan most teams pick is the one wood plank; the others are paper.
            const Surface = highlighted ? WoodPanel : "div";
            return (
              <Surface
                key={name}
                className={`flex min-h-[30rem] min-w-0 flex-col p-5 ${highlighted ? "" : "site-paper-sheet"}`}
              >
                <h3 className="text-xl font-semibold tracking-tight">{name}</h3>
                <p className="mt-2 min-h-12 text-sm leading-6 text-muted-foreground">
                  {description}
                </p>
                <div className="mt-6">
                  <span className="text-4xl font-semibold tracking-tight">{price}</span>
                  {period && <span className="ml-1 text-xs text-muted-foreground">{period}</span>}
                </div>
                {name === "Pro" && (
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    <p>{copy.pro.annual}</p>
                  </div>
                )}
                <div className="my-6 h-px bg-[var(--site-wood-line)]" />
                <ul className="space-y-3">
                  {features.map((feature) => (
                    <li key={feature} className="flex gap-2 text-sm leading-6 text-foreground/90">
                      <Check className="mt-1 size-3.5 shrink-0 text-primary" />
                      {feature}
                    </li>
                  ))}
                </ul>
                {name === "Pro" ? (
                  <div className="mt-auto grid gap-2 pt-6">
                    <LiquidGlassPill
                      as="a"
                      href={href}
                      className="inline-flex h-11 items-center justify-center px-4 text-sm font-semibold"
                    >
                      {copy.pro.monthly}
                    </LiquidGlassPill>
                    <LiquidGlassPill
                      as="a"
                      href={appHref("/login?next=%2Fbilling")}
                      className="inline-flex h-11 items-center justify-center px-4 text-sm font-semibold"
                    >
                      {copy.pro.yearly}
                    </LiquidGlassPill>
                  </div>
                ) : (
                  <LiquidGlassPill
                    as="a"
                    href={href}
                    className="mt-auto inline-flex h-11 items-center justify-center px-4 text-sm font-semibold"
                  >
                    {copy.free.button}
                  </LiquidGlassPill>
                )}
              </Surface>
            );
          })}
        </div>
      </div>
    </section>
  );
}
