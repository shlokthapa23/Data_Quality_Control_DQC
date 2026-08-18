import { Search, X } from 'lucide-react';

/**
 * The control row above a list of tables: a search box, and a select-all that
 * knows about the search.
 *
 * Shared rather than reimplemented per list, because it sits above six
 * different pickers and they must behave identically - a filter that clears
 * differently, or a select-all that means something different, in one place is
 * worse than not having it.
 *
 * Select-all is FILTER-AWARE: with a search active it ticks the matches and
 * says so ("Select all 3 shown"), because a button that silently reaches past
 * what the tester can see is a trap. Pass onSelectAll to get it; lists with no
 * concept of selection (a read-only listing) simply omit it.
 */
export function ListFilter({
  value, onChange, total, shown, threshold = 3,
  placeholder = 'Search tables...', className = '',
  onSelectAll, allSelected = false, someSelected = false, selectedCount,
}) {
  const filtering = value.trim().length > 0;
  const showSearch = total >= threshold;
  const showSelectAll = !!onSelectAll && total > 1;
  if (!showSearch && !showSelectAll) return null;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {showSearch && (
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full pl-8 pr-16 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
          />
          {/* The count is the point: with 100 tables the tester needs to know
              the list is filtered, or an absent table reads as a missing one. */}
          <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {filtering && (
              <>
                <span className="text-[10px] text-slate-400 tabular-nums">{shown}/{total}</span>
                <button
                  onClick={() => onChange('')}
                  title="Clear search"
                  className="p-0.5 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3 h-3" />
                </button>
              </>
            )}
          </span>
        </div>
      )}

      {showSelectAll && (
        <label
          className="flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer shrink-0 whitespace-nowrap"
          title={filtering
            ? 'Ticks only the tables matching your search'
            : 'Ticks every table in this list'}
        >
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
            onChange={() => onSelectAll(!allSelected)}
            className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent"
          />
          {allSelected
            ? 'Clear all'
            : filtering ? `Select all ${shown} shown` : `Select all (${total})`}
          {selectedCount > 0 && !allSelected && (
            <span className="text-slate-400">&middot; {selectedCount} selected</span>
          )}
        </label>
      )}
    </div>
  );
}
