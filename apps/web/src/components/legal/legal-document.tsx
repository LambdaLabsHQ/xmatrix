import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "@/components/shared/brand-mark";
import { WoodPanel } from "@/components/ui/material-surfaces";

export const LEGAL_ENTITY = "MadeByRobot, LLC";
export const LEGAL_CONTACT_EMAIL = "contact@madebyrobot.net";
export const LEGAL_EFFECTIVE_DATE = "Formal public launch date";
export const LEGAL_VERSION = "Pre-launch draft 2026-09-14";

const legalLinks = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Cookies", href: "/cookies" },
  { label: "Subprocessors", href: "/subprocessors" },
] as const;

export function LegalDocument({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="site-page min-h-screen text-foreground">
      <header className="site-legal-header border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8">
          <BrandMark href="/" />
          <nav aria-label="Legal documents" className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-sm font-medium">
            {legalLinks.map((link) => (
              <Link
                key={link.href}
                className="text-muted-foreground transition-colors hover:text-foreground"
                href={link.href}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
        <div className="max-w-3xl">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Legal</p>
          <h1 className="mt-3 text-4xl font-black tracking-tight sm:text-5xl">{title}</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">{description}</p>
          <div className="mt-4 space-y-1 text-sm font-medium text-muted-foreground">
            <p>{LEGAL_VERSION} — not yet effective</p>
            <p>Effective date: {LEGAL_EFFECTIVE_DATE}</p>
          </div>
        </div>

        <WoodPanel as="article" className="site-legal-article mt-12 max-w-3xl pt-2">{children}</WoodPanel>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>&copy; {new Date().getFullYear()} {LEGAL_ENTITY}. All rights reserved.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {legalLinks.map((link) => (
              <Link key={link.href} className="hover:text-foreground" href={link.href}>
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}

export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 border-b border-border py-8 last:border-b-0">
      <h2 className="text-xl font-black tracking-tight">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-7 text-muted-foreground">{children}</div>
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 marker:text-foreground/60">{children}</ul>;
}

export function LegalContactLink({ subject }: { subject?: string }) {
  const href = subject
    ? `mailto:${LEGAL_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`
    : `mailto:${LEGAL_CONTACT_EMAIL}`;
  return <a className="font-medium text-foreground underline underline-offset-4" href={href}>{LEGAL_CONTACT_EMAIL}</a>;
}
