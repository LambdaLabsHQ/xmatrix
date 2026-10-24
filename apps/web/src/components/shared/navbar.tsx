"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu } from "lucide-react";
import { BrandMark } from "@/components/shared/brand-mark";
import { Button } from "@/components/ui/button";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { landingCopy, type Locale } from "@/lib/landing-copy";
import { REPOSITORY_URL } from "@/lib/star-prompt";

const GLASS_REVEAL_DISTANCE_PX = 120;

export function Navbar({ locale = "en" }: { locale?: Locale }) {
  const { home, nav: copy } = landingCopy[locale];
  const [glassReveal, setGlassReveal] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let frame = 0;

    const update = () => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const next = reduceMotion
        ? window.scrollY > 24
          ? 1
          : 0
        : Math.min(1, Math.max(0, window.scrollY / GLASS_REVEAL_DISTANCE_PX));
      setGlassReveal(next);
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header
      className="site-navbar fixed top-0 z-50 w-full"
      data-scrolled={glassReveal > 0.04 ? "true" : "false"}
      style={{ ["--navbar-glass-reveal" as string]: String(glassReveal) }}
    >
      <div className="site-navbar-layout mx-auto">
        <span aria-hidden className="site-navbar-glass">
          <LiquidGlassPill className="size-full">{null}</LiquidGlassPill>
        </span>
        <div className="site-navbar-brand shrink-0">
          <BrandMark
            href={home}
            iconSrc="/brand/xmatrix-icon-transparent-128.png"
            className="relative z-10"
            iconClassName="overflow-visible"
          />
        </div>
        <div className="site-navbar-bar">
          <div className="site-navbar-content relative z-10 flex h-full items-center justify-end gap-4 lg:justify-between">
            <nav className="hidden items-center gap-6 lg:flex">
              {copy.links.map(([href, label]) => (
                <a
                  key={href}
                  href={href}
                  className="text-[13px] font-medium tracking-[-0.015em] text-foreground/65 transition-colors hover:text-foreground"
                >
                  {label}
                </a>
              ))}
            </nav>

            <div className="hidden items-center gap-3 lg:flex">
              <a
                href={REPOSITORY_URL}
                target="_blank"
                rel="noopener"
                className="text-[13px] font-medium tracking-[-0.015em] text-foreground/65 transition-colors hover:text-foreground"
              >
                GitHub
              </a>
              <Link
                href="/docs"
                className="text-[13px] font-medium tracking-[-0.015em] text-foreground/65 transition-colors hover:text-foreground"
              >
                {copy.docs}
              </Link>
              <Link
                href="/app"
                className="text-[13px] font-medium tracking-[-0.015em] text-foreground/65 transition-colors hover:text-foreground"
              >
                {copy.openApp}
              </Link>
              <Link
                href="/login"
                className="site-navbar-cta group inline-flex items-center gap-1 text-[13px] tracking-[-0.015em]"
              >
                {copy.startFree}
                <ArrowRight
                  aria-hidden
                  className="size-3.5 transition-transform group-hover:translate-x-0.5"
                />
              </Link>
            </div>

            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label={copy.menu}
              onClick={() => setMenuOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
          </div>
        </div>

        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="right" className="site-nav-sheet app-material-wood-panel w-72 border-0">
            <nav className="flex flex-col gap-2">
              {copy.links.map(([href, label]) => (
                <LiquidGlassPill
                  key={href}
                  as="a"
                  href={href}
                  onClick={() => setMenuOpen(false)}
                  className="inline-flex h-10 w-full items-center px-3 text-sm font-medium"
                >
                  {label}
                </LiquidGlassPill>
              ))}
              <LiquidGlassPill
                as="a"
                href={REPOSITORY_URL}
                onClick={() => setMenuOpen(false)}
                className="inline-flex h-10 w-full items-center px-3 text-sm font-medium"
              >
                GitHub
              </LiquidGlassPill>
              <LiquidGlassPill
                as={Link}
                href="/docs"
                onClick={() => setMenuOpen(false)}
                className="inline-flex h-10 w-full items-center px-3 text-sm font-medium"
              >
                {copy.docs}
              </LiquidGlassPill>
              <LiquidGlassPill
                as={Link}
                href="/app"
                onClick={() => setMenuOpen(false)}
                className="inline-flex h-10 w-full items-center px-3 text-sm font-medium"
              >
                {copy.openApp}
              </LiquidGlassPill>
              <LiquidGlassPill
                as={Link}
                href="/login"
                onClick={() => setMenuOpen(false)}
                className="mt-2 inline-flex h-11 w-full items-center justify-center text-sm font-semibold text-[#2f281f]"
              >
                {copy.startFree}
              </LiquidGlassPill>
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
