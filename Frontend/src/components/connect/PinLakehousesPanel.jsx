import { useEffect, useState } from 'react';
import { Database, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { fetchAllLakehouses, pinConnectorContainers } from '../../api';
import { ListFilter } from '../common/ListFilter';
import { filterByName, noMatchNote } from '../../listFilter';

export default function PinLakehousesPanel({ connector, onPinned }) {
  const [lakehouses, setLakehouses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(
    new Set((connector.allowed_containers || []).map((c) => c.id))
  );
  const [isSaving, setIsSaving] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
  fetchAllLakehouses(connector.id)
    .then((data) => {
      setLakehouses(data.items);
      setIsLoading(false);
    })
    .catch((err) => {
      setError(err.message);
      setIsLoading(false);
    });
}, [connector.id]);

  const toggle = (lh) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(lh.id) ? next.delete(lh.id) : next.add(lh.id);
      return next;
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const containers = lakehouses
        .filter((lh) => selected.has(lh.id))
        .map((lh) => ({ id: lh.id, name: lh.name }));
      await pinConnectorContainers(connector.id, containers);
      onPinned();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const pinnedCount = (connector.allowed_containers || []).length;
  // Measured against what's actually listed, so a stale pinned id for a
  // Lakehouse that no longer exists can't make "all" look selected.
  const allSelected = lakehouses.length > 0 && lakehouses.every((lh) => selected.has(lh.id));
  const someSelected = lakehouses.some((lh) => selected.has(lh.id));

  return (
    <div className="border-t border-slate-100 bg-slate-50 p-4">
      <div className="flex items-center gap-2 mb-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          S2D &amp; Harvest Lakehouses (select which are usable)
        </h4>
        {pinnedCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-mastek-success">
            <CheckCircle2 className="w-3.5 h-3.5" /> {pinnedCount} pinned
          </span>
        )}

        {/* A workspace can hold plenty of Lakehouses, and ticking them one by
            one to pin the lot is busywork. Indeterminate when only some are
            chosen, so the box reflects the real state rather than implying
            all-or-nothing. */}
        {lakehouses.length > 1 && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
              onChange={() => setSelected(
                allSelected ? new Set() : new Set(lakehouses.map((lh) => lh.id)),
              )}
              className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent"
            />
            {allSelected ? 'Clear all' : `Select all (${lakehouses.length})`}
          </label>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading Lakehouses...
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {!isLoading && !error && (
        <>
          <ListFilter
            value={query} onChange={setQuery} total={lakehouses.length}
            shown={filterByName(lakehouses, query, (l) => l.name).length}
            placeholder="Search Lakehouses..." className="mb-2"
          />
          <div className="space-y-1.5 mb-3 max-h-56 overflow-y-auto">
            {lakehouses.length > 0 && filterByName(lakehouses, query, (l) => l.name).length === 0 && (
              <p className="text-sm text-slate-400 italic">{noMatchNote(query)}</p>
            )}
            {filterByName(lakehouses, query, (l) => l.name).map((lh) => {
              const checked = selected.has(lh.id);
              return (
                <label
                  key={lh.id}
                  className={`flex items-center gap-2 px-3 py-1.5 bg-white border rounded-lg text-sm cursor-pointer ${
                    checked ? 'border-mastek-primary/40' : 'border-slate-200'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(lh)}
                    className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent"
                  />
                  <Database className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-slate-700">{lh.name}</span>
                </label>
              );
            })}
            {lakehouses.length === 0 && (
              <p className="text-sm text-slate-400 italic">No Lakehouses found in this workspace.</p>
            )}
          </div>

          <button
            onClick={handleSave}
            disabled={selected.size === 0 || isSaving}
            className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            Pin Selected ({selected.size})
          </button>
        </>
      )}
    </div>
  );
}