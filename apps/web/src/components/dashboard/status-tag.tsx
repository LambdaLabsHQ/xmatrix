"use client";

/* One definition per tag.
 *
 * The message header and the live-agent rail deliberately show different tags —
 * they are emphasising different things — but a tag of a given kind must be
 * drawn in exactly one place. Anything that needs a tag composes `Tag`, or the
 * kind-specific component below, rather than respelling the material, the size,
 * the icon gap, or the truncation for a second time.
 *
 * `TAG_SHAPE_CLASS` is geometry and type only. Tags that carry a status tone of
 * their own — the goal badge — paint their own surface over the same shape;
 * every other tag takes the shared chip material from `tagClass`, rendered
 * through `LiquidGlassPill`, the composer buttons' own primitive, so it blurs
 * and bends the backdrop exactly as they do.
 */

import { GitPullRequest } from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

import { COUNT_CHIP_MATERIAL_CLASS } from "./workspace-shell-constants";

export const TAG_SHAPE_CLASS =
  "inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold";

export function tagClass(...extra: Array<string | false | undefined>): string {
  return cn(TAG_SHAPE_CLASS, COUNT_CHIP_MATERIAL_CLASS, "text-muted-foreground", ...extra);
}

export function Tag({
  icon: Icon,
  title,
  className,
  /* Identity values are read as one token, so they are never cut mid-word; every
     other tag truncates inside the row's width. */
  nowrap,
  fill,
  chipId,
  data,
  children,
  onClick,
  expanded,
}: {
  /* Lucide's icons and the vendored octicons are both plain SVG components; a
     tag only ever hands one a className. */
  icon: ComponentType<Pick<SVGProps<SVGSVGElement>, "className">>;
  title?: string;
  className?: string;
  nowrap?: boolean;
  /** Painted under the label, e.g. the usage meter behind a quota tag. */
  fill?: ReactNode;
  /** Identifies the tag to tests and to the tag editor. */
  chipId?: string;
  /** Extra `data-*` hooks a specific tag kind needs; keys must start with `data-`. */
  data?: Record<`data-${string}`, string | boolean>;
  children: ReactNode;
  /** Present when this tag can be changed from here, absent when it only reports. */
  onClick?: () => void;
  expanded?: boolean;
}) {
  const shell = cn(
    tagClass(),
    "relative",
    nowrap ? "whitespace-nowrap" : "max-w-[11rem] overflow-hidden truncate",
    className,
  );
  const body = (
    <>
      {fill}
      <Icon className="relative z-[1] size-3 shrink-0" />
      <span className={cn("relative z-[1]", nowrap ? "whitespace-nowrap" : "truncate")}>{children}</span>
    </>
  );
  /* A tag that cannot be changed stays a span. Rendering every tag as a button
     would offer a control on facts like context usage that nothing can set. */
  if (!onClick) {
    return (
      <LiquidGlassPill as="span" className={shell} title={title} aria-label={title} data-status-chip={chipId} {...data}>
        {body}
      </LiquidGlassPill>
    );
  }
  return (
    <LiquidGlassPill
      as="button"
      type="button"
      className={cn(shell, "hover:text-foreground")}
      title={title}
      aria-label={title}
      aria-haspopup="listbox"
      aria-expanded={expanded === true}
      data-status-chip={chipId}
      onClick={onClick}
      {...data}
    >
      {body}
    </LiquidGlassPill>
  );
}

export function BranchBadge({ branch, live }: { branch: string; live?: boolean }) {
  return (
    <Tag
      icon={GitPullRequest}
      title={`Branch: ${branch}`}
      className="app-message-branch-badge max-w-[10rem]"
      {...(live ? { data: { "data-live-agent-branch": true } } : {})}
    >
      {branch}
    </Tag>
  );
}
