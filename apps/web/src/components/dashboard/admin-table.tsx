"use client";

/**
 * The one table every platform-admin list uses: search, sortable headers,
 * pages of rows, and CSV export, with its state in the address so a filtered
 * view can be shared. It sits on the paper like the rest of the tool views —
 * rules between rows, no card around it.
 */

import { useMemo, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search } from "lucide-react";

import { actionClass } from "@/components/ui/action-tone";
import { GlassSelect } from "@/components/ui/glass-select";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAdminParam } from "./platform-admin-data";
import { adminTableCsv, sortAdminRows, type AdminSortableColumn } from "./platform-admin-overview";
import { useIsMobileViewport } from "./workspace-shell-helpers";

/** A column: its sort and export value (none: not sortable), and how a cell reads. */
export interface AdminColumn<Row> extends AdminSortableColumn<Row> {
  /** Numbers and times read right-aligned. */
  numeric?: boolean;
  /** Exported but not drawn, e.g. a value already shown inside another cell. */
  hidden?: boolean;
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
  return (
    <ul className="divide-y divide-border/60 border-y border-border/60">
      {rows.map((row) => {
        const body = (
          <>
            <div className="min-w-0 [overflow-wrap:anywhere]">{lead?.render(row)}</div>
            {rest.length > 0 && (
              <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                {rest.map((column) => (
                  <div key={column.key} className="flex min-w-0 max-w-full items-baseline gap-1">
                    <dt className="shrink-0 text-muted-foreground">{column.label}</dt>
                    <dd className="min-w-0 tabular-nums [overflow-wrap:anywhere]">{column.render(row)}</dd>
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
                className="block w-full min-w-0 py-3 text-left active:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring">
                {body}
              </button>
            ) : <div className="py-2.5">{body}</div>}
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
    <section aria-label={label} className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {search && (
          <div className={cn("relative", phone && "w-full")}>
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(""); }}
              placeholder={searchPlaceholder ?? "Search"}
              aria-label={`Search ${label}`}
              className={cn("pl-7", phone ? "h-11 w-full text-base" : "h-8 w-60 text-xs")}
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
              className="h-11 rounded-md px-2 text-sm"
            />
            <button type="button" onClick={() => toggleSort(sortColumn)}
              aria-label={descending ? "Sorted descending; sort ascending" : "Sorted ascending; sort descending"}
              className={cn(actionClass({ variant: "secondary", size: "sm" }), "min-h-11 min-w-11")}>
              {descending ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
            </button>
          </>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {filtered.length === rows.length ? rows.length : `${filtered.length} of ${rows.length}`}
        </span>
        <button
          type="button"
          aria-label={`Export ${label} as CSV`}
          onClick={() => download(`${id || "admin"}-${new Date().toISOString().slice(0, 10)}.csv`, adminTableCsv(filtered, columns))}
          disabled={filtered.length === 0}
          className={cn(actionClass({ variant: "secondary", size: "sm" }), phone && "min-h-11 min-w-11")}
        >
          <Download className="size-3.5" /> {!phone && "CSV"}
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">{empty}</p>
      ) : phone ? (
        <AdminRowList rows={shown} columns={visible} rowKey={rowKey} onRowClick={onRowClick} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-black uppercase tracking-wide text-muted-foreground">
                {visible.map((column) => {
                  const active = column.key === sortKey && Boolean(column.value);
                  return (
                    <th key={column.key} scope="col"
                      aria-sort={active ? (descending ? "descending" : "ascending") : undefined}
                      className={cn("whitespace-nowrap px-2 py-2 first:pl-0 last:pr-0", column.numeric && "text-right")}>
                      {column.value ? (
                        <button type="button" onClick={() => toggleSort(column)}
                          className={cn("inline-flex items-center gap-0.5 uppercase hover:text-foreground",
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
                      className={cn("max-w-[260px] px-2 py-2 align-top first:pl-0 last:pr-0",
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
          <button type="button" aria-label="Previous page" disabled={page <= 1}
            onClick={() => setPage(page - 1 <= 1 ? "" : String(page - 1))}
            className={cn(actionClass({ variant: "secondary", size: "sm" }), phone && "min-h-11 min-w-11")}>
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="tabular-nums">Page {page} of {pages}</span>
          <button type="button" aria-label="Next page" disabled={page >= pages}
            onClick={() => setPage(String(page + 1))}
            className={cn(actionClass({ variant: "secondary", size: "sm" }), phone && "min-h-11 min-w-11")}>
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}
