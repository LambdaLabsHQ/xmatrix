import Image from "next/image";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { BrandMark } from "@/components/shared/brand-mark";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

/* The one frame every sign-in screen (login code, password, reset, device
   approval) is drawn in: the homepage's wood-and-glass art beside a sheet of
   paper, so arriving from "Start Free" still looks like the same product. */
export function AuthShell({ children, legal = true }: { children: ReactNode; legal?: boolean }) {
  return (
    <main className="site-page auth-page">
      <aside className="auth-art" aria-hidden="true">
        <Image
          src="/brand/xmatrix-hero-wood-liquid-glass-ai-logos-compact.png"
          alt=""
          fill
          sizes="(min-width: 1024px) 50vw, 100vw"
          priority
          className="object-cover"
        />
      </aside>
      <div className="auth-column">
        <BrandMark
          href="/"
          iconSrc="/brand/xmatrix-icon-transparent.png"
          iconClassName="size-8"
          wordmarkClassName="site-display text-lg"
        />
        <div className="auth-body">{children}</div>
        {legal ? (
          <p className="auth-legal">
            By continuing, you agree to the xMatrix <Link href="/terms">Terms of Service</Link> and
            acknowledge the <Link href="/privacy">Privacy Policy</Link>.
          </p>
        ) : null}
      </div>
    </main>
  );
}

export function AuthHeading({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="auth-heading">
      <h1 className="site-display">{title}</h1>
      {children ? <p>{children}</p> : null}
    </header>
  );
}

/** The screen's one main action: the homepage "Start Free" wood plank. */
export function AuthPrimaryButton({ className, type = "button", ...props }: Omit<ComponentProps<"button">, "ref">) {
  return <WoodPanel as="button" type={type} className={cn("site-wood-pill auth-button", className)} {...props} />;
}

export function AuthSecondaryButton({ className, type = "button", ...props }: ComponentProps<"button">) {
  return <button type={type} className={cn("auth-button auth-button-secondary", className)} {...props} />;
}

export function AuthDivider({ children = "or" }: { children?: ReactNode }) {
  return <div className="auth-divider" role="separator">{children}</div>;
}

/** Who asked for this sign-in, shown before the person approves a handoff. */
export function AuthRequest({ icon, title, code, children }: {
  icon: ReactNode;
  title: ReactNode;
  code?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="auth-request">
      <div className="auth-request-title">{icon}<span>{title}</span></div>
      {code ? <p className="auth-request-code" data-testid="device-approval-code">{code}</p> : null}
      {children ? <div className="auth-request-body">{children}</div> : null}
    </div>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return children ? <p role="alert" className="auth-error">{children}</p> : null;
}

export function AuthLinks({ children }: { children: ReactNode }) {
  return <div className="auth-links">{children}</div>;
}
