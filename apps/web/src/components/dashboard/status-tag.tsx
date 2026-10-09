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
 * their own — the goal badge — paint their own surface over the same shape.
 * Every other tag is ink on the paper, from `tagClass`: an icon and a word with
 * no surface of its own, the way a detail page's context line reads. A row of
 * glass capsules beside a glass avatar was six raised objects per header
 * (user 2026-10-09: 头像和标签都改成纸面风格，不然看着太乱了).
 */

import { GitPullRequest } from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { cn } from "@/lib/utils";

export const TAG_SHAPE_CLASS =
  "inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold";

/** Ink on the paper: no surface, so no padding to hold one. */
export const INK_TAG_CLASS = "app-ink-tag px-0 text-muted-foreground";

export function tagClass(...extra: Array<string | false | undefined>): string {
  return cn(TAG_SHAPE_CLASS, INK_TAG_CLASS, ...extra);
}

/* A usage meter on an ink tag is a line under its words: the share used in the
   meter's tone, over a faint track when the meter is the tag's whole point. */
export function UsageMeterLine({ percent, tone, track }: { percent: number; tone: string; track?: boolean }) {
  return (
    <>
      {track ? <span aria-hidden className="app-usage-meter-track pointer-events-none absolute bottom-0 inset-x-0 h-0.5 rounded-full" /> : null}
      <span
        aria-hidden
        className="app-usage-meter-fill pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full"
        data-tone={tone}
        style={{ width: `${percent}%` }}
      />
    </>
  );
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
  /** Drawn under the label, e.g. the usage meter of a quota tag. */
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
      <span className={shell} title={title} aria-label={title} data-status-chip={chipId} {...data}>
        {body}
      </span>
    );
  }
  return (
    <button
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
    </button>
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
