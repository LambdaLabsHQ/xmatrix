"use client";

/**
 * The one table every platform-admin list uses: search, sortable headers,
 * pages of rows, and CSV export, with its state in the address so a filtered
 * view can be shared. It sits on the paper like the rest of the tool views —
 * rules between rows, no card around it.
 */

import { useMemo, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { SearchGlyph } from "@/components/ui/search-glyph";

import { GlassSelect } from "@/components/ui/glass-select";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAdminParam } from "./platform-admin-data";
import { adminTableCsv, sortAdminRows, type AdminSortableColumn } from "./platform-admin-overview";
import { useIsMobileViewport } from "./workspace-shell-helpers";
import { AdminPaperAction } from "./admin-paper";

/** A column: its sort and export value (none: not sortable), and how a cell reads. */
export interface AdminColumn<Row> extends AdminSortableColumn<Row> {
  /** Numbers and times read right-aligned. */
  numeric?: boolean;
  /** Exported but not drawn, e.g. a value already shown inside another cell. */
  hidden?: boolean;
  /** A phone emphasizes a few counts; other visible fields remain labelled metadata. */
  mobile?: "metric" | "meta" | false;
  render: (row: Row) => ReactNode;
}

const PAGE_SIZE = 50;

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * A phone reads each row as a list row: the first column as its name, the
 * others as labelled values under it, so nothing scrolls sideways.
 */
function AdminRowList<Row>({ rows, columns, rowKey, onRowClick }: {
  rows: readonly Row[];
  columns: readonly AdminColumn<Row>[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
}) {
  const [lead, ...rest] = columns;
  const metrics = rest.filter((column) => column.mobile === "metric");
  const metadata = rest.filter((column) => column.mobile !== "metric" && column.mobile !== false);
  return (
    <ul className="app-admin-row-list divide-y divide-border/60 border-b border-border/60">
      {rows.map((row) => {
        const body = (
          <>
            <div className="min-w-0 [overflow-wrap:anywhere]">{lead?.render(row)}</div>
            {metrics.length > 0 && (
              <dl className="app-admin-row-metrics mt-3 grid grid-cols-4 gap-x-2 py-2 text-xs">
                {metrics.map((column) => (
                  <div key={column.key} className="min-w-0">
                    <dt className="text-[11px] text-muted-foreground">{column.label}</dt>
                    <dd className="mt-0.5 text-base font-semibold leading-5 tabular-nums">{column.render(row)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {metadata.length > 0 && (
              <dl className="mt-2 space-y-1 text-[11px]">
                {metadata.map((column) => (
                  <div key={column.key} className="flex min-w-0 items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{column.label}</dt>
                    <dd className="min-w-0 text-right tabular-nums [overflow-wrap:anywhere] [&_.truncate]:whitespace-normal">{column.render(row)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        );
        return (
          <li key={rowKey(row)}>
            {onRowClick ? (
              <button type="button" onClick={() => onRowClick(row)}
                className="block w-full min-w-0 px-3 py-3 text-left active:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring">
                {body}
              </button>
            ) : <div className="px-3 py-3">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

export function AdminTable<Row>({
  id,
  label,
  rows,
  columns,
  rowKey,
  search,
  searchPlaceholder,
  defaultSort,
  onRowClick,
  empty,
  note,
  toolbar,
}: {
  /** Prefix of this table's address parameters; unique per view. */
  id: string;
  label: string;
  rows: readonly Row[];
  columns: readonly AdminColumn<Row>[];
  rowKey: (row: Row) => string;
  /** The text a row is searched by; no search box without it. */
  search?: (row: Row) => string;
  searchPlaceholder?: string;
  /** Column key, descending. */
  defaultSort?: string;
  onRowClick?: (row: Row) => void;
  empty: string;
  /** A line under the table, such as a cut-off notice. */
  note?: ReactNode;
  toolbar?: ReactNode;
}) {
  const [query, setQuery] = useAdminParam(`${id}q`);
  const [sortParam, setSort] = useAdminParam(`${id}sort`);
  const [pageParam, setPage] = useAdminParam(`${id}page`);
  // "-key" sorts descending, "key" ascending.
  const requestedSort = sortParam || (defaultSort ? `-${defaultSort}` : "");
  const sortable = columns.filter((column) => column.value);
  const sort = sortable.some((column) => column.key === requestedSort.replace(/^-/, ""))
    ? requestedSort : defaultSort ? `-${defaultSort}` : sortable[0]?.key ?? "";
  const descending = sort.startsWith("-");
  const sortKey = descending ? sort.slice(1) : sort;
  const sortColumn = columns.find((column) => column.key === sortKey);
  const visible = columns.filter((column) => !column.hidden);
  const phone = useIsMobileViewport();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle && search ? rows.filter((row) => search(row).toLowerCase().includes(needle)) : rows;
    return sortAdminRows(matched, sortColumn, descending);
  }, [rows, query, search, sortColumn, descending]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pageParam) || 1), pages);
  const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleSort = (column: AdminColumn<Row>) => {
    if (!column.value) return;
    // Numbers and times start with the largest; text starts at A.
    const first = column.numeric ? `-${column.key}` : column.key;
    const next = sortKey === column.key ? (descending ? column.key : `-${column.key}`) : first;
    setSort(next === `-${defaultSort}` ? "" : next);
    setPage("");
  };

  return (
    <section aria-label={label} className="app-admin-table min-w-0">
      <div className="app-admin-table-tools flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border/60 px-3 md:gap-x-3">
        {search && (
          <div className={cn("relative", phone && "w-full")}>
            <SearchGlyph className="pointer-events-none absolute left-0 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(""); }}
              placeholder={searchPlaceholder ?? "Search"}
              aria-label={`Search ${label}`}
              className={cn("rounded-none border-0 bg-transparent pl-5 pr-0 shadow-none focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-ring", phone ? "h-11 w-full text-base" : "h-8 w-60 text-xs")}
            />
          </div>
        )}
        {toolbar}
        {/* A phone has no headers to tap: the sort is chosen here, its direction beside it. */}
        {phone && sortColumn && (
          <>
            <GlassSelect
              value={sortColumn.key}
              onChange={(key) => {
                const column = columns.find((candidate) => candidate.key === key);
                if (column && column.key !== sortKey) toggleSort(column);
              }}
              options={sortable.map((column) => ({ value: column.key, label: column.label }))}
              aria-label={`Sort ${label}`}
              className="h-11 px-0"
            />
            <AdminPaperAction onClick={() => toggleSort(sortColumn)}
              aria-label={descending ? "Sorted descending; sort ascending" : "Sorted ascending; sort descending"}
              className="min-w-11 md:min-w-8">
              {descending ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
            </AdminPaperAction>
          </>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {filtered.length === rows.length ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}` : `${filtered.length} of ${rows.length}`}
        </span>
        <AdminPaperAction
          aria-label={`Export ${label} as CSV`}
          onClick={() => download(`${id || "admin"}-${new Date().toISOString().slice(0, 10)}.csv`, adminTableCsv(filtered, columns))}
          disabled={filtered.length === 0}
        >
          <Download className="size-3.5" /> CSV
        </AdminPaperAction>
      </div>
      {filtered.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">{empty}</p>
      ) : phone ? (
        <AdminRowList rows={shown} columns={visible} rowKey={rowKey} onRowClick={onRowClick} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold text-muted-foreground">
                {visible.map((column) => {
                  const active = column.key === sortKey && Boolean(column.value);
                  return (
                    <th key={column.key} scope="col"
                      aria-sort={active ? (descending ? "descending" : "ascending") : undefined}
                      className={cn("whitespace-nowrap px-2 py-2.5 first:pl-3 last:pr-3", column.numeric && "text-right")}>
                      {column.value ? (
                        <button type="button" onClick={() => toggleSort(column)}
                          className={cn("inline-flex items-center gap-0.5 hover:text-foreground",
                            active && "text-foreground")}>
                          {column.label}
                          {active && (descending ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                        </button>
                      ) : column.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (event) => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRowClick(row); }
                  } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  className={cn("border-b border-border/60", onRowClick && "cursor-pointer hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none")}>
                  {visible.map((column) => (
                    <td key={column.key}
                      className={cn("max-w-[260px] px-2 py-3 align-top first:pl-3 last:pr-3",
                        column.numeric && "text-right tabular-nums")}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <AdminPaperAction aria-label="Previous page" disabled={page <= 1}
            onClick={() => setPage(page - 1 <= 1 ? "" : String(page - 1))}
            className="min-w-11 md:min-w-8">
            <ChevronLeft className="size-3.5" />
          </AdminPaperAction>
          <span className="tabular-nums">Page {page} of {pages}</span>
          <AdminPaperAction aria-label="Next page" disabled={page >= pages}
            onClick={() => setPage(String(page + 1))}
            className="min-w-11 md:min-w-8">
            <ChevronRight className="size-3.5" />
          </AdminPaperAction>
        </div>
      )}
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
