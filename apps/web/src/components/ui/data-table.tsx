'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { EmptyState } from './empty-state';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Enables sorting on this column (client-side, or reported via onSortChange when controlled). */
  sortValue?: (row: T) => string | number | null;
  align?: 'left' | 'right' | 'center';
  className?: string;
  width?: string;
}

export interface SortState {
  key: string;
  order: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Controlled sorting (server-side). When omitted, sorting happens in the browser. */
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** Server-side pagination. */
  pagination?: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void };
  caption?: string;
  className?: string;
}

/**
 * Dense, readable data grid (blueprint 12.3): 48px rows, sticky header, sorting,
 * pagination and a clear empty state.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  emptyTitle = 'Nothing to show yet',
  emptyDescription,
  onRowClick,
  sort: controlledSort,
  onSortChange,
  pagination,
  caption,
  className,
}: DataTableProps<T>) {
  const [localSort, setLocalSort] = useState<SortState | null>(null);
  const sort = controlledSort !== undefined ? controlledSort : localSort;

  const sorted = useMemo(() => {
    if (!sort || onSortChange) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.order === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av === bv) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av > bv ? dir : -dir;
    });
  }, [rows, sort, columns, onSortChange]);

  const toggleSort = (key: string) => {
    const next: SortState = sort?.key === key && sort.order === 'asc' ? { key, order: 'desc' } : { key, order: 'asc' };
    if (onSortChange) onSortChange(next);
    else setLocalSort(next);
  };

  const pageCount = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;

  return (
    <div className={cn('ngao-card overflow-hidden', className)}>
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse text-body">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="sticky top-0 z-10 bg-cloud">
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={c.width ? { width: c.width } : undefined}
                    aria-sort={active ? (sort!.order === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn(
                      'h-10 border-b border-line px-3 text-meta font-semibold uppercase tracking-wide text-slate',
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    )}
                  >
                    {c.sortValue ? (
                      <button type="button" onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 hover:text-ink">
                        {c.header}
                        {active ? (
                          sort!.order === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-50" aria-hidden />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`} className="h-row border-b border-line last:border-0">
                  {columns.map((c) => (
                    <td key={c.key} className="px-3">
                      <div className="h-3 w-2/3 animate-pulse rounded bg-cloud" />
                    </td>
                  ))}
                </tr>
              ))
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState title={emptyTitle} description={emptyDescription} />
                </td>
              </tr>
            ) : (
              sorted.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => (e.key === 'Enter' ? onRowClick(row) : undefined) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  className={cn('h-row border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-cloud/70')}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn('px-3 py-2', c.align === 'right' ? 'text-right tabular-nums' : c.align === 'center' ? 'text-center' : 'text-left', c.className)}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pagination ? (
        <div className="flex items-center justify-between border-t border-line px-3 py-2 text-meta text-slate">
          <span>
            {formatNumber(pagination.total)} records · page {pagination.page} of {pageCount}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 hover:bg-cloud disabled:opacity-40"
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded p-1 hover:bg-cloud disabled:opacity-40"
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              disabled={pagination.page >= pageCount}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
