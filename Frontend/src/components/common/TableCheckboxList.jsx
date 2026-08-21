import { useState } from 'react';
import { ListFilter } from './ListFilter';
import { filterByName, noMatchNote } from '../../listFilter';
import { formatRowCount, rowCountStyle, rowCountTitle } from '../../rowCount';

// rowCounts is { tableName: count }. Counts arrive with the schema fetch, so
// while it's in flight a table simply has no entry - deliberately rendered as
// nothing rather than a placeholder, so the list doesn't flicker.
// Note the ?? rather than ||: an empty table's count is 0, which is falsy, and
// hiding "0" would suppress exactly the case a tester most wants to notice.
//
// Shared between TestCasePanel (every table picker in the test case editor)
// and ColumnMapModal (picking which tables to show columns for) - one
// picker, one behavior, rather than two that could drift apart.
export function TableCheckboxList({ tables, selected, onToggle, rowCounts = {} }) {
  const [query, setQuery] = useState('');
  const visible = filterByName(tables, query);
  const allVisibleSelected = visible.length > 0 && visible.every((t) => selected.includes(t));
  return (
    <div className="space-y-1.5">
      <ListFilter
        value={query} onChange={setQuery} total={tables.length} shown={visible.length}
        selectedCount={selected.length}
        allSelected={allVisibleSelected}
        someSelected={visible.some((t) => selected.includes(t))}
        // Acts on the filtered set, so "select all 3 shown" means exactly that.
        // Built from the per-item onToggle rather than a bespoke handler at each
        // call site: every one of those toggles is a functional setState
        // ((prev) => ...), so a run of them composes correctly under React's
        // batching and there is no second code path to keep in step.
        onSelectAll={(on) => visible
          .filter((t) => selected.includes(t) !== on)
          .forEach((t) => onToggle(t))}
      />
      <div className="border border-slate-300 rounded-lg max-h-32 overflow-y-auto">
      {tables.length === 0 && <p className="text-sm text-slate-400 italic px-3 py-2">No tables</p>}
      {tables.length > 0 && visible.length === 0 && (
        <p className="text-sm text-slate-400 italic px-3 py-2">{noMatchNote(query)}</p>
      )}
      {visible.map((t) => {
        const count = rowCounts[t];
        return (
          <label key={t} className="flex items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0">
            <input
              type="checkbox"
              checked={selected.includes(t)}
              onChange={() => onToggle(t)}
              className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent shrink-0"
            />
            <span className="truncate">{t}</span>
            {count !== undefined && (
              <span
                className={`ml-auto shrink-0 text-[11px] px-1.5 py-0.5 rounded ${rowCountStyle(count)}`}
                title={rowCountTitle(count)}
              >
                {formatRowCount(count)}
              </span>
            )}
          </label>
        );
      })}
      </div>
    </div>
  );
}
