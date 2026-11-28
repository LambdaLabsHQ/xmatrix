"use client";

import { createContext, Fragment, useContext, type ReactNode } from "react";
import { Files } from "lucide-react";

import { PageTreeRow } from "@/components/pages/page-tree-row";
import { cn } from "@/lib/utils";

import { ListSkeleton, SkeletonBar, SkeletonCircle } from "./content-skeleton";
import {
  FLEET_HERO_CLASS,
  FLEET_HERO_SUMMARY_CLASS,
  FLEET_HERO_TITLE_CLASS,
  FLEET_MATRIX_CELL_CLASS,
  FLEET_MATRIX_CELL_LINE_CLASS,
  FLEET_MATRIX_CELL_TD_CLASS,
  FLEET_MATRIX_COLUMN_FILLER_WIDTH_CLASS,
  FLEET_MATRIX_COLUMN_HEADING_CLASS,
  FLEET_MATRIX_COLUMN_NAME_CLASS,
  FLEET_MATRIX_COLUMN_TH_CLASS,
  FLEET_MATRIX_MACHINE_FACTS_CLASS,
  FLEET_MATRIX_MACHINE_HEADING_CLASS,
  FLEET_MATRIX_MACHINE_LABEL_CLASS,
  FLEET_MATRIX_MACHINE_NAME_CLASS,
  FLEET_MATRIX_MACHINE_TH_CLASS,
  FLEET_MATRIX_ROW_TH_CLASS,
  FLEET_MATRIX_SCROLL_CLASS,
  FLEET_MATRIX_TABLE_CLASS,
  FLEET_MATRIX_WRAPPER_CLASS,
  MOBILE_FLEET_LIST_CONTAINER_CLASS,
  MOBILE_MATRIX_CELL_CLASS,
  MOBILE_MATRIX_HEADING_CLASS,
  MOBILE_MATRIX_MACHINE_NAME_CLASS,
  MOBILE_MATRIX_ROOT_CLASS,
  MOBILE_MATRIX_SECTION_CLASS,
  mobileMatrixGridStyle,
} from "./fleet-matrix-frames";
import { ListSectionHeading } from "./list-section-heading";
import {
  ToolDetail,
  ToolDetailSection,
  ToolList,
  ToolPaper,
  ToolPaperScroll,
  ToolSettingRow,
  ToolSheet,
  ToolSplit,
} from "./tool-split";
import { isFleetView, viewLabels, type AppView } from "./workspace-shell-navigation";

const NOOP = () => {};

/** Carries the active shell destination into dynamic chunk loading fallbacks
 *  so a view loading its module paints the same layout frame it will land in. */
export const ActiveToolViewContext = createContext<AppView>("messages");

export function useActiveToolView(): AppView {
  return useContext(ActiveToolViewContext);
}

const FLEET_SKELETON_COLUMNS = ["3.75rem", "3.25rem", "4.25rem", "3.5rem"] as const;
const FLEET_SKELETON_ROWS = [
  { name: "7.5rem", facts: "6.5rem", cells: ["3.5rem", "4rem", "2.5rem", "3rem"] },
  { name: "6rem", facts: "5.5rem", cells: ["3rem", "3.5rem", "3rem", "2.25rem"] },
  { name: "8.5rem", facts: "7rem", cells: ["4rem", "2.75rem", "3.5rem", "3rem"] },
] as const;

const PAGE_SKELETON_ROWS = [
  ["8.5rem", "62%"],
  ["6.5rem", "48%"],
  ["10rem", "70%"],
  ["7rem", "42%"],
  ["9rem", "58%"],
  ["6rem", "44%"],
] as const;

const DETAIL_SKELETON_SECTIONS = [
  [
    ["8rem", "68%"],
    ["6.5rem", "52%"],
  ],
  [
    ["9.5rem", "60%"],
    ["7rem", "46%"],
  ],
] as const;

const PAGE_DOCUMENT_PARAGRAPHS = [
  ["94%", "86%", "58%"],
  ["88%", "74%"],
] as const;

/**
 * Placeholder desktop Agents × Machines matrix inside FleetMatrix's own table
 * boxes (fleet-matrix-frames.ts). When machine rows are already known while the
 * Space's agent catalog is still in flight, those real row headings stay put
 * and only the pending columns and cells show bars.
 */
export function FleetMatrixSkeleton({
  label = "Loading machines and agents",
  knownRows,
}: {
  label?: string;
  knownRows?: ReadonlyArray<{ key: string; heading: ReactNode; dimmed?: boolean }>;
}) {
  const rowCount = knownRows && knownRows.length > 0 ? knownRows.length : FLEET_SKELETON_ROWS.length;
  return (
    <div className={cn(FLEET_MATRIX_WRAPPER_CLASS, "app-skeleton-inert")} role="status" aria-label={label}>
      <div className={FLEET_MATRIX_SCROLL_CLASS} aria-hidden="true">
        <table className={FLEET_MATRIX_TABLE_CLASS}>
          <thead>
            <tr>
              <th scope="col" className={FLEET_MATRIX_MACHINE_TH_CLASS}>
                <span className={FLEET_MATRIX_MACHINE_LABEL_CLASS}>Machine</span>
              </th>
              {FLEET_SKELETON_COLUMNS.map((width, columnIndex) => (
                <th key={columnIndex} scope="col" className={cn(FLEET_MATRIX_COLUMN_TH_CLASS, FLEET_MATRIX_COLUMN_FILLER_WIDTH_CLASS)}>
                  <span className={FLEET_MATRIX_COLUMN_HEADING_CLASS}>
                    <SkeletonCircle className="size-8 shrink-0" />
                    <span className={FLEET_MATRIX_COLUMN_NAME_CLASS}><SkeletonBar width={width} /></span>
                  </span>
                </th>
              ))}
              <th aria-hidden="true" className="w-full border-b border-foreground/10" />
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, rowIndex) => {
              const template = FLEET_SKELETON_ROWS[rowIndex % FLEET_SKELETON_ROWS.length]!;
              const known = knownRows?.[rowIndex];
              return (
                <tr key={known?.key ?? rowIndex}>
                  <th scope="row" className={FLEET_MATRIX_ROW_TH_CLASS}>
                    {known ? known.heading : (
                      <span className={FLEET_MATRIX_MACHINE_HEADING_CLASS}>
                        <span className="app-list-skeleton-mark shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className={FLEET_MATRIX_MACHINE_NAME_CLASS}><SkeletonBar width={template.name} /></span>
                          <span className={FLEET_MATRIX_MACHINE_FACTS_CLASS}><SkeletonBar width={template.facts} /></span>
                        </span>
                      </span>
                    )}
                  </th>
                  {template.cells.map((cellWidth, cellIndex) => (
                    <td key={cellIndex} className={cn(FLEET_MATRIX_CELL_TD_CLASS, known?.dimmed && "opacity-55")}>
                      <span className={FLEET_MATRIX_CELL_CLASS}>
                        <span className={FLEET_MATRIX_CELL_LINE_CLASS}>
                          <SkeletonBar width={cellWidth} />
                        </span>
                      </span>
                    </td>
                  ))}
                  <td aria-hidden="true" className="border-b border-foreground/10" />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Placeholder phone avatar matrix inside MobileAvatarMatrix's own section and grid boxes. */
export function MobileAvatarMatrixSkeleton({
  label = "Loading machines and agents",
}: {
  label?: string;
}) {
  const gridStyle = mobileMatrixGridStyle(FLEET_SKELETON_COLUMNS.length);
  return (
    <div className={cn(MOBILE_MATRIX_ROOT_CLASS, "app-skeleton-inert")} role="status" aria-label={label}>
      {FLEET_SKELETON_ROWS.map((row, index) => (
        <section
          key={index}
          aria-hidden="true"
          className={cn(MOBILE_MATRIX_SECTION_CLASS, index > 0 && "border-t border-foreground/[0.08]")}
        >
          <div className={MOBILE_MATRIX_HEADING_CLASS}>
            <span className="app-list-skeleton-mark shrink-0" />
            <span className={MOBILE_MATRIX_MACHINE_NAME_CLASS}><SkeletonBar width={row.name} /></span>
          </div>
          <div className="grid items-center" style={gridStyle}>
            {FLEET_SKELETON_COLUMNS.map((_, slot) => (
              <span key={slot} className={MOBILE_MATRIX_CELL_CLASS}>
                <SkeletonCircle className="size-8" />
                <span className="h-1" />
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The Agents / Status destination while its module or data is still arriving:
 * full-width matrix sheet on desktop, machine-and-avatar list on phone.
 */
export function FleetOverviewSkeleton({
  label = "Loading machines and agents",
  status,
}: {
  label?: string;
  status?: ReactNode;
}) {
  return (
    <>
      <div className="hidden min-h-0 min-w-0 flex-1 md:flex">
        <ToolSheet label="Agents">
          <ToolPaperScroll full>
            <header className={FLEET_HERO_CLASS}>
              <h1 className={FLEET_HERO_TITLE_CLASS}>System Overview</h1>
              <p className={FLEET_HERO_SUMMARY_CLASS}><SkeletonBar width="11rem" /></p>
            </header>
            <div className="space-y-6">
              <FleetMatrixSkeleton label={label} />
              {status}
            </div>
          </ToolPaperScroll>
        </ToolSheet>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 md:hidden">
        <ToolSplit
          label="Agents"
          open={false}
          list={(
            <ToolList title="Agents">
              <div className={MOBILE_FLEET_LIST_CONTAINER_CLASS}>
                <MobileAvatarMatrixSkeleton label={label} />
                {status}
              </div>
            </ToolList>
          )}
          detail={null}
        />
      </div>
    </>
  );
}

/** Placeholder detail paper inside ToolDetail's own header and section primitives. */
export function ToolDetailSkeleton({
  label = "Loading",
  context,
  backLabel,
  backAlways,
  wide,
  sections = 2,
  status,
}: {
  label?: string;
  context?: string;
  backLabel?: string;
  backAlways?: boolean;
  wide?: boolean;
  sections?: number;
  status?: ReactNode;
}) {
  return (
    <div className="app-skeleton-inert flex min-h-0 min-w-0 flex-1 flex-col" role="status" aria-label={label}>
      <div aria-hidden="true" inert className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ToolDetail
          onBack={backLabel ? NOOP : undefined}
          backLabel={backLabel}
          backAlways={backAlways}
          context={context}
          wide={wide}
          title={<SkeletonBar width="12rem" />}
          status={<SkeletonBar width="16rem" />}
        >
          {DETAIL_SKELETON_SECTIONS.slice(0, sections).map((rows, sectionIndex) => (
            <ToolDetailSection key={sectionIndex} title="Section">
              <div className="divide-y divide-border/50">
                {rows.map(([titleWidth, descWidth], rowIndex) => (
                  <ToolSettingRow
                    key={rowIndex}
                    title={<SkeletonBar width={titleWidth} />}
                    description={<SkeletonBar width={descWidth} />}
                  />
                ))}
              </div>
            </ToolDetailSection>
          ))}
          {status}
        </ToolDetail>
      </div>
    </div>
  );
}

/** Placeholder split tool destination (Settings, Team, Apps, Admin) inside ToolSplit. */
export function ToolSplitSkeleton({
  title,
  label = `Loading ${title.toLowerCase()}`,
  wide,
  rows = 6,
  status,
}: {
  title: string;
  label?: string;
  wide?: boolean;
  rows?: number;
  status?: ReactNode;
}) {
  return (
    <ToolSplit
      label={title}
      open={false}
      list={(
        <ToolList title={title}>
          <ListSkeleton label={label} rows={rows} />
          <div className="md:hidden">{status}</div>
        </ToolList>
      )}
      detail={<ToolDetailSkeleton label={label} context={title} wide={wide} status={status} />}
    />
  );
}

/** Placeholder single-paper destination (Profile, Activity, More) inside ToolPaper. */
export function ToolPaperSkeleton({
  title,
  label = `Loading ${title.toLowerCase()}`,
  status,
}: {
  title: string;
  label?: string;
  status?: ReactNode;
}) {
  return (
    <ToolPaper label={title}>
      <ToolDetailSkeleton label={label} status={status} />
    </ToolPaper>
  );
}

/**
 * Placeholder page tree inside PageTreeRow's own boxes, holding the Overview's
 * entry and the section heading's room above the first row so rows do not
 * shift when the tree lands.
 */
export function PageListSkeleton({
  label = "Loading pages",
  rows = PAGE_SKELETON_ROWS.length,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="app-list-skeleton" role="status" aria-label={label}>
      <div aria-hidden="true" inert>
        {/* The Overview's entry leads a Space's pages: its heading's room and its taller row are held too. */}
        <div className="invisible">
          <ListSectionHeading label="Up to date" mark={{ icon: Files, tone: "plain" }} />
        </div>
        <ul>
          <li>
            <div className="app-page-overview-row app-list-row flex min-w-0 flex-col justify-center">
              <span className="app-page-row-title-line flex min-w-0 items-center gap-2">
                <span className="app-list-skeleton-mark shrink-0" />
                <span className="app-list-row-title min-w-0 flex-1 truncate"><SkeletonBar width="6.5rem" /></span>
              </span>
              <span className="app-list-row-meta truncate"><SkeletonBar width="7rem" /></span>
            </div>
          </li>
        </ul>
        <div className="invisible">
          <ListSectionHeading label="All pages" mark={{ icon: Files, tone: "primary" }} />
        </div>
        <ul>
          {PAGE_SKELETON_ROWS.slice(0, rows).map(([title, meta], index) => (
            <li key={index}>
              <PageTreeRow depth={0} selected={false} open={false} onToggle={NOOP} expandHidden>
                <span className="flex min-w-0 flex-1 flex-col text-left">
                  <span className="app-page-row-title-line flex min-w-0 items-center gap-2">
                    <span className="app-list-skeleton-mark shrink-0" />
                    <span className="app-page-row-title app-list-row-title min-w-0 truncate">
                      <SkeletonBar width={title} />
                    </span>
                    <span className="app-channel-row-time ml-auto shrink-0 pl-2">
                      <SkeletonBar width="1.25rem" />
                    </span>
                  </span>
                  <span className="app-page-row-meta-line flex min-w-0 items-center gap-1.5">
                    <span className="app-list-row-meta min-w-0 flex-1 truncate">
                      <SkeletonBar width={meta} />
                    </span>
                  </span>
                </span>
              </PageTreeRow>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Placeholder document inside the page editor's own prose classes (`ProseMirror page-document`). */
export function PageDocumentSkeleton({
  label = "Loading page",
}: {
  label?: string;
}) {
  return (
    <div
      className="ProseMirror page-document app-skeleton-inert min-h-[50vh]"
      role="status"
      aria-label={label}
    >
      <div aria-hidden="true">
        <h1><SkeletonBar width="15rem" /></h1>
        {PAGE_DOCUMENT_PARAGRAPHS.map((lines, paragraphIndex) => (
          <p key={paragraphIndex}>
            {lines.map((width, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                <SkeletonBar width={width} />
              </Fragment>
            ))}
          </p>
        ))}
        <h2><SkeletonBar width="10rem" /></h2>
        <p>
          <SkeletonBar width="84%" />
          <br />
          <SkeletonBar width="62%" />
        </p>
      </div>
    </div>
  );
}

/** Shared view-matched skeleton for every ToolSurface destination. */
export function ToolSurfaceSkeleton({
  view,
  status,
}: {
  view: Exclude<AppView, "messages" | "pages">;
  status?: ReactNode;
}) {
  if (isFleetView(view)) {
    return <FleetOverviewSkeleton status={status} />;
  }
  if (view === "settings" || view === "team" || view === "apps" || view === "admin") {
    return <ToolSplitSkeleton title={viewLabels[view]} wide={view === "admin"} status={status} />;
  }
  return <ToolPaperSkeleton title={viewLabels[view]} status={status} />;
}

/** Dynamic-chunk fallback for ToolSurface: reads the destination being opened. */
export function ActiveToolSurfaceLoading() {
  const view = useActiveToolView();
  if (view === "messages" || view === "pages") {
    return <ToolPaperSkeleton title="Workspace" label="Loading" />;
  }
  return <ToolSurfaceSkeleton view={view} />;
}
