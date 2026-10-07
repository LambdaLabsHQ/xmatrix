"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Paper actions are ink, with a large touch target but no raised surface. */
export function AdminPaperAction({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn(
    "app-admin-action inline-flex min-h-11 items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground",
    "hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 md:min-h-8",
    className,
  )} {...props} />;
}
