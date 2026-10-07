"use client";

import { Check } from "lucide-react";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { FREE_PLAN_FEATURES, PRO_PLAN_FEATURES } from "@/lib/space-plans";

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "",
    description: "Prove the workflow before you pay.",
    features: FREE_PLAN_FEATURES,
    href: "/login",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$10",
    period: "/human seat/mo",
    description: "Coordinate people and any number of agents.",
    features: PRO_PLAN_FEATURES,
    href: "/login?next=%2Fbilling",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "Govern agents across your organization.",
    features: ["Unlimited agents", "Private deployment", "Policy controls + SLA"],
    href: "mailto:enterprise@xmatrix.sh",
    highlighted: false,
  },
] as const;

export function Pricing() {
  return (
    <section id="pricing" className="x-section">
      <div className="x-container">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
            People pay. Agents don&apos;t.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            Every plan supports unlimited agents. Upgrade when more people need the control plane,
            not when your agent fleet grows.
          </p>
        </div>

        <div className="x-mobile-card-scroller mx-auto mt-14 grid min-w-0 max-w-5xl gap-4 md:grid-cols-3">
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
                    <p>$96 per seat/year ($8/mo, save 20%)</p>
                    <p>Promotions, if available, are applied securely during checkout.</p>
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
                      Choose monthly
                    </LiquidGlassPill>
                    <LiquidGlassPill
                      as="a"
                      href="/login?next=%2Fbilling"
                      className="inline-flex h-11 items-center justify-center px-4 text-sm font-semibold"
                    >
                      Annual, save 20%
                    </LiquidGlassPill>
                  </div>
                ) : (
                  <LiquidGlassPill
                    as="a"
                    href={href}
                    className="mt-auto inline-flex h-11 items-center justify-center px-4 text-sm font-semibold"
                  >
                    {name === "Free" ? "Start Free" : "Contact Sales"}
                  </LiquidGlassPill>
                )}
              </Surface>
            );
          })}
        </div>
        <p className="mt-6 text-center text-xs leading-5 text-muted-foreground">
          Free includes 500 lifetime messages. Paid messaging is unmetered; fair-use and service
          rate limits apply.
        </p>
      </div>
    </section>
  );
}
