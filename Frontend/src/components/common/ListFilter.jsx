import { Search, X } from 'lucide-react';

/**
 * A search box for a list that has grown past the point of scanning by eye.
 *
 * Shared rather than reimplemented per list, because it appears above six
 * different table pickers and they must behave identically - a filter that
 * clears differently in one place is worse than no filter.
 *
 * Hidden below `threshold` items on purpose: a search box over five tables is
 * clutter that makes the common case worse to serve the rare one.
 */
export function ListFilter({
  value, onChange, total, shown, threshold = 10, placeholder = 'Search tables...', className = '',
}) {
  if (total < threshold) return null;
  return (
    <div className={`relative ${className}`}>
      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-8 pr-16 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
      />
      {/* The count is the point: with 100 tables the tester needs to know the
          list is filtered, or an absent table reads as a missing table. */}
      <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {value && (
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
  );
}
