"use client";

import type { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/* Shared frame for the first-run cards that stand in for an empty Space
   screen. They are consecutive steps of one flow, so they have to look like one
   flow rather than two similar ones. The frame stays transparent so the
   detail paper behind it is the only material; rows are ruled, not carded. */

export function SetupCardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-space-setup-frame mx-auto w-full max-w-2xl px-5 py-10">
      <section className="app-space-setup-card p-6 sm:p-7">{children}</section>
    </div>
  );
}

export function SetupCardHeader({
  icon: Icon,
  iconClassName,
  title,
  titleId,
  body,
}: {
  icon?: typeof Sparkles;
  iconClassName?: string;
  title: string;
  titleId?: string;
  body: string;
}) {
  return (
    <div className="flex min-w-0 gap-4">
      {Icon && (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className={cn("size-5 text-muted-foreground", iconClassName)} />
        </span>
      )}
      <div className="min-w-0">
        <h2 id={titleId} className="text-lg font-black leading-tight">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
