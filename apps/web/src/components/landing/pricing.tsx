"use client";

import { Check } from "lucide-react";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { landingCopy, type Locale } from "@/lib/landing-copy";

export function Pricing({ locale = "en" }: { locale?: Locale }) {
  const copy = landingCopy[locale].pricing;
  const plans = [
    { name: "Free", price: "$0", period: "", ...copy.free, href: "/login", highlighted: false },
    { name: "Pro", price: "$10", ...copy.pro, href: "/login?next=%2Fbilling", highlighted: true },
  ];
  return (
    <section id="pricing" className="x-section">
      <div className="x-container">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="site-display text-3xl font-semibold text-foreground sm:text-5xl">
            {copy.title}
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            {copy.body}
          </p>
        </div>

        <div className="x-mobile-card-scroller mx-auto mt-14 grid min-w-0 max-w-3xl gap-4 md:grid-cols-2">
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
                    <p>{copy.pro.promotions}</p>
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
                      href="/login?next=%2Fbilling"
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
        <p className="mt-6 text-center text-xs leading-5 text-muted-foreground">
          {copy.terms}
        </p>
        {copy.xCreditsLink ? (
          <p className="mx-auto mt-8 max-w-3xl text-center text-sm">
            <a className="text-primary underline" href={copy.xCreditsLink.href}>{copy.xCreditsLink.label}</a>
          </p>
        ) : <div className="mx-auto mt-8 max-w-3xl text-sm">
          <h3 className="font-semibold">X API credits on Pro</h3>
          <p className="mt-2 text-muted-foreground">Connect your X account directly. Paid actions use your Space&apos;s credit balance, including actions a person runs or approves.</p>
          <table className="mt-4 w-full text-left text-sm">
            <thead><tr className="border-b"><th className="py-2 font-medium">Action</th><th className="py-2 font-medium">Credits</th></tr></thead>
            <tbody>
              <tr className="border-b"><td className="py-2">Plain text post</td><td>30 / request</td></tr>
              <tr className="border-b"><td className="py-2">Post with a URL, quote or attached media</td><td>400 / request*</td></tr>
              <tr className="border-b"><td className="py-2">Read posts or a timeline</td><td>10 / returned post</td></tr>
              <tr className="border-b"><td className="py-2">Profile lookup, including Connect and Check</td><td>20 / profile</td></tr>
              <tr><td className="py-2">Media upload requests and status</td><td>30 / request, provisional</td></tr>
            </tbody>
          </table>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">A timeline reserves up to 100 credits and a video reserves its maximum upload request count; unused requests are released. *Quote/attached-media and media upload/status pricing is provisional pending verification of upstream charges. Approval requests, local account lists and token refresh are free. Pre-request failures and definite X rejections are refunded; uncertain outcomes retain their reservation. Results show credits charged or reserved and remaining.</p>
        </div>}
      </div>
    </section>
  );
}
