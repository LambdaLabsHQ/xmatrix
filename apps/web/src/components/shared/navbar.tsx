"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { BrandMark } from "@/components/shared/brand-mark";
import { Button } from "@/components/ui/button";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { REPOSITORY_URL } from "@/lib/star-prompt";

const navLinks = [
  { href: "/download", label: "Download" },
  { href: "/#connectors", label: "Connectors" },
  { href: "/#pricing", label: "Pricing" },
];

const GLASS_REVEAL_DISTANCE_PX = 120;

export function Navbar() {
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
            href="/"
            iconSrc="/brand/xmatrix-icon-transparent-128.png"
            className="relative z-10"
            iconClassName="overflow-visible"
          />
        </div>
        <div className="site-navbar-bar">
          <div className="site-navbar-content relative z-10 flex h-full items-center justify-end gap-4 lg:justify-between">
            <nav className="hidden items-center gap-6 lg:flex">
              {navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-[13px] font-medium tracking-[-0.015em] text-foreground/65 transition-colors hover:text-foreground"
                >
                  {link.label}
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
                Docs
              </Link>
              <Link
                href="/app"
                className="text-[13px] font-medium tracking-[-0.015em] text-foreground/65 transition-colors hover:text-foreground"
              >
                Open App
              </Link>
              <LiquidGlassPill
                as={Link}
                href="/login"
                onSlab
                className="inline-flex h-8 items-center justify-center px-4 text-[13px] font-semibold text-[#2f281f]"
              >
                Start Free
              </LiquidGlassPill>
            </div>

            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation menu"
              onClick={() => setMenuOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
          </div>
        </div>

        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="right" className="site-nav-sheet app-material-wood-panel w-72 border-0">
            <nav className="flex flex-col gap-2">
              {navLinks.map((link) => (
                <LiquidGlassPill
                  key={link.href}
                  as="a"
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="inline-flex h-10 w-full items-center px-3 text-sm font-medium"
                >
                  {link.label}
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
                Docs
              </LiquidGlassPill>
              <LiquidGlassPill
                as={Link}
                href="/app"
                onClick={() => setMenuOpen(false)}
                className="inline-flex h-10 w-full items-center px-3 text-sm font-medium"
              >
                Open App
              </LiquidGlassPill>
              <LiquidGlassPill
                as={Link}
                href="/login"
                onClick={() => setMenuOpen(false)}
                className="mt-2 inline-flex h-11 w-full items-center justify-center text-sm font-semibold text-[#2f281f]"
              >
                Start Free
              </LiquidGlassPill>
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
