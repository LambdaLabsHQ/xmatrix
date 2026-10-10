"use client";

import { Children, createContext, useCallback, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ListColumnResizeHandle } from "./list-column-resize";
import { ListCreate, type CreateAction } from "./list-create";
import {
  LIST_ROW_CLASS_NAME,
  LIST_ROW_COPY_CLASS_NAME,
  LIST_ROW_LEADING_CLASS_NAME,
  LIST_ROW_LEADING_TWO_LINE_CLASS_NAME,
  LIST_ROW_META_CLASS_NAME,
  LIST_ROW_TITLE_CLASS_NAME,
  LIST_ROW_TITLE_LINE_CLASS_NAME,
} from "./row-frames";
import { parseAppLocation, pushBrowserPath, replaceBrowserPath, toolItemSelection } from "./workspace-shell-navigation";

/*
 * Every rail destination reads the way conversations and pages do: the rail,
 * then a list, then the thing chosen from it. The list is the panel's darker
 * left column and the chosen item is read on the panel's paper beside it. On
 * a phone the list is the screen and the item is pushed over it, with a way
 * back. Nothing here is a board or a card: tone is the only surface.
 */

const ITEM_PARAM = "item";
const ITEM_EVENT = "xmatrix:tool-item";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(ITEM_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(ITEM_EVENT, onChange);
  };
}

function readItem(): string | null {
  return toolItemSelection(window.location.href);
}

/**
 * The item a destination has open, named in its address (`?item=<key>`) so it
 * can be shared and Back closes it. The destination's own path is kept.
 */
export function useToolItem(): [string | null, (item: string | null, options?: { replace?: boolean }) => void] {
  const item = useSyncExternalStore(subscribe, readItem, () => null);
  const select = useCallback((next: string | null, options: { replace?: boolean } = {}) => {
    if (next === readItem()) return;
    const url = parseAppLocation(window.location.href);
    if (next) url.searchParams.set(ITEM_PARAM, next);
    else url.searchParams.delete(ITEM_PARAM);
    const path = `${url.pathname}${url.search}${url.hash}`;
    // Moving between items replaces; opening one from the bare list is a step Back returns from.
    if (options.replace || readItem()) replaceBrowserPath(path);
    else pushBrowserPath(path);
    window.dispatchEvent(new Event(ITEM_EVENT));
  }, []);
  return [item, select];
}

export function ToolSplit({ list, detail, open, label }: {
  list: ReactNode;
  detail: ReactNode;
  /** Whether an item is open: on a phone it then replaces the list. */
  open: boolean;
  label: string;
}) {
  return (
    <div className="app-tool-split flex min-h-0 min-w-0 flex-1" data-open={open ? "true" : "false"} aria-label={label}
      role="region">
      <nav aria-label={`${label} list`}
        className={cn("app-tool-list flex min-h-0 min-w-0 flex-col md:w-[var(--app-desktop-sidebar-width,300px)] md:shrink-0",
          open ? "max-md:hidden" : "max-md:flex-1")}>
        {list}
      </nav>
      <ListColumnResizeHandle className="md:flex" />
      <section className={cn("app-tool-detail flex min-h-0 min-w-0 flex-1 flex-col", !open && "max-md:hidden")}>
        {detail}
      </section>
    </div>
  );
}

/** The list column: its name, its + as the first row, one optional control, then the rows. */
export function ToolList({ title, action, create, createLead, toolbar, children }: {
  title: string;
  action?: ReactNode;
  create?: CreateAction | null;
  createLead?: "avatar";
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="app-band-header flex items-center justify-between gap-2 px-5 pt-3 pb-2">
        <h1 className="text-xs font-black uppercase tracking-wide text-muted-foreground">{title}</h1>
        {action}
      </div>
      <ListCreate action={create ?? null} lead={createLead} />
      {toolbar && <div className="px-5 pb-2">{toolbar}</div>}
      <div className="app-tool-list-scroll min-h-0 flex-1 overflow-y-auto pb-4">{children}</div>
    </>
  );
}

/** Rows under an identity heading are indented to start where the heading's
 * name does (its padding, 2rem icon and gap), so they read as its children. */
const IdentityIndent = createContext(false);

export function ToolListGroup({ title, icon, count, onTitle, titleHint, identity, limit, children }: {
  title: string;
  icon?: ReactNode;
  count?: number;
  onTitle?: () => void;
  titleHint?: string;
  /** The heading is the thing the rows belong to, so its icon and name use the
   * row's scale. A section label (the default) stays small and quiet. */
  identity?: boolean;
  /** Show only this many rows until the reader asks for the rest; at 0 the
   * heading itself opens and closes the group. */
  limit?: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = Children.toArray(children);
  const folds = limit !== undefined && rows.length > limit;
  const hidden = folds && !expanded ? rows.length - (limit ?? 0) : 0;
  const headingToggles = folds && limit === 0;
  const label = (
    <>
      {icon}
      <span className={cn("min-w-0 truncate", identity && "app-list-row-title")}>{title}</span>
      {headingToggles && <ChevronDown aria-hidden="true"
        className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />}
      {count !== undefined && (
        <span className={cn("ml-auto pl-2 tabular-nums",
          identity ? "text-sm font-medium text-muted-foreground" : "font-medium")}>
          {count}
        </span>
      )}
    </>
  );
  const titleClass = cn(
    "app-tool-list-group-title flex min-w-0 items-center pl-[var(--app-list-row-start)] pr-[var(--app-list-row-end)] text-left",
    identity
      ? "app-list-row gap-2.5 py-2 text-base font-semibold text-foreground"
      : "gap-1.5 py-1.5 text-xs font-bold text-muted-foreground",
    (onTitle || headingToggles) && "w-full hover:text-foreground",
  );
  return (
    <section className="app-tool-list-group mt-2 first:mt-0" aria-label={title}>
      {headingToggles ? (
        <button type="button" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded} className={titleClass}>
          {label}
        </button>
      ) : onTitle ? (
        <button type="button" onClick={onTitle} title={titleHint} className={titleClass}>
          {label}
        </button>
      ) : (
        <div className={titleClass}>{label}</div>
      )}
      <IdentityIndent.Provider value={Boolean(identity)}>
        <ul>
          {hidden ? rows.slice(0, limit) : rows}
          {folds && !headingToggles && (
            <li>
              <button type="button" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}
                data-testid="tool-list-more"
                className="flex w-full items-center gap-1 py-1.5 pl-[var(--app-list-row-start)] pr-[var(--app-list-row-end)] text-left text-xs font-semibold text-muted-foreground hover:text-foreground">
                {expanded ? "Show less" : `Show ${hidden} more`}
                <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
              </button>
            </li>
          )}
        </ul>
      </IdentityIndent.Provider>
    </section>
  );
}

/** One row: a leading mark, the name with something at its end, and one line under it. */
export function ToolListRow({ selected, shownBeside, onSelect, leading, title, end, trailing, subtitle, testId, state, phoneOnly }: {
  selected: boolean;
  /** A row only a phone lists, where a desktop shows it as the list's +. */
  phoneOnly?: boolean;
  /** Shown on the paper beside the list without being chosen: marked on a desktop only. */
  shownBeside?: boolean;
  onSelect: () => void;
  leading?: ReactNode;
  title: ReactNode;
  end?: ReactNode;
  /** Live state beside the text, centred on the row; the name gives way to it. */
  trailing?: ReactNode;
  subtitle?: ReactNode;
  testId?: string;
  state?: string;
}) {
  const indented = useContext(IdentityIndent);
  return (
    <li className={phoneOnly ? "md:hidden" : undefined}>
      <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} data-testid={testId}
        data-state={state}
        className={cn("app-tool-list-row", LIST_ROW_CLASS_NAME,
          indented && "pl-[calc(var(--app-list-row-start)+2.625rem)]",
          selected && "app-tool-list-row-selected", shownBeside && "app-tool-list-row-beside")}>
        {leading && <span className={cn(LIST_ROW_LEADING_CLASS_NAME, subtitle && LIST_ROW_LEADING_TWO_LINE_CLASS_NAME)}>{leading}</span>}
        <span className={LIST_ROW_COPY_CLASS_NAME}>
          <span className={LIST_ROW_TITLE_LINE_CLASS_NAME}>
            <span className={LIST_ROW_TITLE_CLASS_NAME}>{title}</span>
            {end && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{end}</span>}
          </span>
          {subtitle && <span className={LIST_ROW_META_CLASS_NAME}>{subtitle}</span>}
        </span>
        {trailing}
      </button>
    </li>
  );
}

export type ToolState = "running" | "paused" | "attention" | "offline";

/** A status mark: a small round dot whose colour is the state. */
export function ToolStateDot({ state }: { state: ToolState }) {
  return <span className="app-tool-dot" data-state={state} aria-hidden="true" />;
}

/** The chosen item, on paper: where it sits, its name, one line of state, what to do; then its sections. */
export function ToolDetail({ onBack, backLabel, context, title, titleAccessory, status, actions, wide, children }: {
  /** A phone's way back to the list; the overview shown beside the list has none. */
  onBack?: () => void;
  backLabel?: string;
  context?: ReactNode;
  title: ReactNode;
  /** Sits on the title. Hidden until the title is hovered, and always shown where there is no hover. */
  titleAccessory?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  /** Tables of many columns read on a wider sheet than prose. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <ToolPaperScroll wide={wide}>
      {onBack && (
        <button type="button" onClick={onBack}
          className="-ml-1 mb-2 flex items-center gap-0.5 text-sm font-medium text-muted-foreground hover:text-foreground md:hidden">
          <ChevronLeft className="size-4" /> {backLabel}
        </button>
      )}
      <header className="app-tool-detail-header mb-6">
        {context && <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">{context}</div>}
        <div className={cn("group/title inline-flex max-w-full items-center gap-0.5", !titleAccessory && "w-full")}>
          <h2 className={cn("min-w-0 break-words text-2xl font-black", !titleAccessory && "w-full")}>{title}</h2>
          {titleAccessory && (
            <div className="flex shrink-0 items-center opacity-100 md:opacity-0 md:group-hover/title:opacity-100 md:focus-within:opacity-100">
              {titleAccessory}
            </div>
          )}
        </div>
        {status && <div className="mt-1 text-sm text-muted-foreground">{status}</div>}
        {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="space-y-10">{children}</div>
    </ToolPaperScroll>
  );
}

/** The paper's scroll and text column; a view that draws its own header (Profile) uses it directly. */
export function ToolPaperScroll({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className="app-tool-detail-scroll min-h-0 flex-1 overflow-y-auto">
      {/* On a phone the paper's text keeps to the plank's content line. */}
      <article className={cn("mx-auto px-[var(--mobile-content-inset,1rem)] pt-3 pb-[calc(env(safe-area-inset-bottom)+2rem)] md:px-8 md:pt-8",
        wide ? "max-w-6xl" : "max-w-3xl")}>
        {children}
      </article>
    </div>
  );
}

/**
 * A destination with nothing to list — Profile, Activity, More — read on the
 * same paper as a chosen item, without the list beside it. Wood stays the
 * chrome around it; the content is never a board or a card.
 */
export function ToolPaper({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="app-tool-paper app-tool-detail flex min-h-0 min-w-0 flex-1 flex-col" aria-label={label}>
      {children}
    </section>
  );
}

/** A titled part of the paper; an `action` sits at the end of its title rule. */
export function ToolDetailSection({ title, action, concealAction, children }: {
  title: string;
  action?: ReactNode;
  /** The action is upkeep of this section: shown on hover, and always where there is no hover. */
  concealAction?: boolean;
  children: ReactNode;
}) {
  const heading = "text-[15px] font-bold text-foreground";
  return (
    <section aria-label={title} className="group/section">
      {action ? (
        <div className="app-tool-detail-section-title mb-1 flex min-w-0 items-center justify-between gap-2 pb-1.5">
          <h3 className={cn("min-w-0 truncate", heading)}>{title}</h3>
          <div className={cn("-my-1 flex shrink-0 items-center gap-1", concealAction
            && "opacity-100 md:opacity-0 md:group-hover/section:opacity-100 md:focus-within:opacity-100")}>{action}</div>
        </div>
      ) : (
        <h3 className={cn("app-tool-detail-section-title mb-1 pb-2", heading)}>{title}</h3>
      )}
      {children}
    </section>
  );
}

/**
 * One setting on the paper, as GitHub and Notion lay them out: what it is and
 * why on the left, its control on the right, a hairline under it. A wide
 * control (a text box) goes under the words instead.
 */
export function ToolSettingRow({ title, description, control, below }: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="py-3.5">
      <div className="flex items-center gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {description && <div className="mt-0.5 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">{description}</div>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {below && <div className="mt-3">{below}</div>}
    </div>
  );
}

/** Label-and-value lines, two columns wide where there is room. */
export function ToolFacts({ children }: { children: ReactNode }) {
  return <dl className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">{children}</dl>;
}

export function ToolFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** What the paper shows when no item is chosen, or none exists. */
export function ToolDetailEmpty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center text-sm text-muted-foreground">
        {icon && <div className="mb-3 flex justify-center text-muted-foreground [&_svg]:size-7">{icon}</div>}
        <p className="font-bold text-foreground">{title}</p>
        {children && <div className="mt-1 space-y-3">{children}</div>}
      </div>
    </div>
  );
}

export type ToolSection = {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** One line under the label in the list: the section's state at a glance. */
  summary?: ReactNode;
  /** A short tag at the end of the label in the list, such as "Current". */
  end?: ReactNode;
  /** One line under the title on the paper. */
  description?: ReactNode;
  actions?: ReactNode;
  content: ReactNode;
  /** The section that makes a new one: the list's + rather than a row. */
  create?: boolean;
  /** Read on the wide sheet, for tables of many columns. */
  wide?: boolean;
};

/**
 * A destination made of sections rather than records — Settings, Platform
 * admin: the list names the sections and the paper shows one. On a desktop
 * the first is shown until another is chosen; on a phone the list comes first.
 */
export function SectionedToolView({ title, sections, label = title, defaultKey }: {
  title: string;
  sections: ToolSection[];
  label?: string;
  /** The section shown on a desktop while the address names none. */
  defaultKey?: string;
}) {
  const [item, select] = useToolItem();
  const chosen = sections.find((section) => section.key === item);
  const shown = chosen ?? sections.find((section) => section.key === defaultKey) ?? sections[0];
  const createSection = sections.find((section) => section.create);
  return (
    <ToolSplit
      label={label}
      open={Boolean(chosen)}
      list={
        <ToolList title={title} create={createSection
          ? { label: createSection.label, onCreate: () => select(createSection.key), active: chosen === createSection }
          : null}>
          <ul>
            {sections.map((section) => {
              const Icon = section.icon;
              return (
                <ToolListRow key={section.key} testId="tool-section-row" selected={section.key === chosen?.key}
                  phoneOnly={section.create}
                  shownBeside={!chosen && section.key === shown?.key}
                  onSelect={() => select(section.key)}
                  leading={Icon ? <Icon className="size-4 text-muted-foreground" /> : undefined}
                  title={section.label} end={section.end} subtitle={section.summary} />
              );
            })}
          </ul>
        </ToolList>
      }
      detail={shown ? (
        <ToolDetail onBack={() => select(null)} backLabel={title} context={title} title={shown.label}
          status={shown.description} actions={shown.actions} wide={shown.wide}>
          {shown.content}
        </ToolDetail>
      ) : null}
    />
  );
}
