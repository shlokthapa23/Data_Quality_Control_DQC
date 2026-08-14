import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, Plus, Trash2, Wand2, AlertCircle } from 'lucide-react';
import { fetchContainerTables, saveS2DColumnMap } from '../../api';
import { autoMatchEntries, normalizeName } from '../../columnMap';

/**
 * Editor for a validation's opt-in column map.
 *
 * Rows are common names; columns are every table in the validation. Each cell
 * picks which physical column of that table the common name refers to, so a
 * test case can reference one name even when the tables spell the field
 * differently. Leaving a cell unmapped is fine and expected - nothing here is
 * enforced on any table the tester doesn't explicitly map.
 */

// Fabric table names arrive fully qualified and double-quoted
// ('"dbo"."orders"'), which is unreadable as a column header. Show the last
// part, keep the full name in a title tooltip.
function shortTableName(table) {
  const parts = String(table).split('.');
  return parts[parts.length - 1].replace(/"/g, '');
}

let nextRowId = 0;
const withId = (entry) => ({ ...entry, _id: (nextRowId += 1) });

const emptyRow = () => withId({ name: '', source: {}, destination: {} });

export default function ColumnMapModal({ mapping, onClose, onSaved }) {
  const [schemas, setSchemas] = useState({ source: {}, destination: {} });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [rows, setRows] = useState(() => (mapping.column_map || []).map(withId));
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Same per-selection fetch idiom TestCasePanel uses - a cancelled flag so a
  // slow response for a mapping we've already navigated away from can't land
  // on top of newer state. isLoading/loadError are seeded to their pending
  // values at useState time rather than reset synchronously in here, so the
  // effect only ever settles state from the callback.
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchContainerTables(mapping.source_connector_id, mapping.source_container_id),
      fetchContainerTables(mapping.destination_connector_id, mapping.destination_container_id),
    ])
      .then(([sourceData, destinationData]) => {
        if (cancelled) return;
        const index = (data, tables) =>
          Object.fromEntries(
            (data.tables || [])
              .filter((t) => tables.includes(t.name))
              .map((t) => [t.name, t.columns || []])
          );
        setSchemas({
          source: index(sourceData, mapping.source_tables),
          destination: index(destinationData, mapping.destination_tables),
        });
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err.message);
        setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [mapping]);

  // Source tables first, then destination - the order the tester thinks about
  // the pipeline in.
  const columns = useMemo(
    () => [
      ...mapping.source_tables.map((table) => ({ side: 'source', table })),
      ...mapping.destination_tables.map((table) => ({ side: 'destination', table })),
    ],
    [mapping]
  );

  const updateRow = (id, patch) => {
    setRows((rs) => rs.map((r) => (r._id === id ? { ...r, ...patch } : r)));
    setIsDirty(true);
  };

  const setCell = (id, side, table, columnName) => {
    setRows((rs) =>
      rs.map((r) => {
        if (r._id !== id) return r;
        const sideMap = { ...(r[side] || {}) };
        if (columnName) sideMap[table] = columnName;
        else delete sideMap[table]; // the "--" option means "not mapped"
        return { ...r, [side]: sideMap };
      })
    );
    setIsDirty(true);
  };

  const addRow = () => {
    setRows((rs) => [...rs, emptyRow()]);
    setIsDirty(true);
  };

  const removeRow = (id) => {
    setRows((rs) => rs.filter((r) => r._id !== id));
    setIsDirty(true);
  };

  /**
   * Propose rows for every group of columns whose names match once case,
   * underscores and spaces are folded away. Purely additive: existing rows are
   * never touched, and a proposal whose name collides with one is skipped, so
   * pressing this after hand-editing can't destroy work. Nothing persists
   * until Save.
   */
  const handleAutoMatch = () => {
    const tablesBySide = {
      source: mapping.source_tables.map((table) => ({ table, columns: schemas.source[table] })),
      destination: mapping.destination_tables.map((table) => ({ table, columns: schemas.destination[table] })),
    };
    const taken = new Set(rows.map((r) => normalizeName(r.name)).filter(Boolean));
    const proposed = autoMatchEntries(tablesBySide).filter((e) => !taken.has(normalizeName(e.name)));

    if (proposed.length === 0) {
      setSaveError('Auto-match found no new column groups - every match is already listed below.');
      return;
    }
    setSaveError(null);
    setRows((rs) => [...rs, ...proposed.map(withId)]);
    setIsDirty(true);
  };

  const handleSave = () => {
    setIsSaving(true);
    setSaveError(null);
    const payload = rows.map(({ name, source, destination }) => ({ name: name.trim(), source, destination }));

    saveS2DColumnMap(mapping.id, payload)
      .then((updated) => {
        setIsSaving(false);
        setIsDirty(false);
        onSaved(updated);
        onClose();
      })
      .catch((err) => {
        setIsSaving(false);
        setSaveError(err.message);
      });
  };

  const handleClose = () => {
    if (isDirty && !confirm('Discard unsaved changes to this column map?')) return;
    onClose();
  };

  const coverageOf = (row) =>
    columns.filter(({ side, table }) => (row[side] || {})[table]).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 sticky top-0 bg-white z-10">
          <div>
            <span className="font-semibold text-slate-800">Map Columns</span>
            <span className="ml-2 text-sm text-slate-400">{mapping.name}</span>
            <p className="text-xs text-slate-400 mt-0.5">
              Give differently-named columns one common name, so a single test case can check them all.
              Optional &mdash; leave this empty and everything keeps working on plain column names.
            </p>
          </div>
          <button onClick={handleClose} className="p-1 hover:bg-slate-100 rounded-lg shrink-0">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-6">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading table schemas...
            </div>
          )}
          {loadError && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4" /> {loadError}
            </div>
          )}

          {!isLoading && !loadError && (
            <>
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs font-medium text-slate-400 border-b border-slate-100 bg-white">
                    <tr>
                      <th className="px-3 py-3 min-w-[11rem]">Common name</th>
                      {columns.map(({ side, table }) => (
                        <th key={`${side}:${table}`} className="px-3 py-3 min-w-[10rem]" title={table}>
                          <span className="block text-slate-600 font-mono truncate">{shortTableName(table)}</span>
                          <span
                            className={`text-[10px] uppercase tracking-wider ${
                              side === 'source' ? 'text-mastek-secondary' : 'text-mastek-highlight'
                            }`}
                          >
                            {side}
                          </span>
                        </th>
                      ))}
                      <th className="px-3 py-3 w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={columns.length + 2} className="px-3 py-8 text-center text-sm text-slate-400">
                          No common names yet. Add one, or let auto-match propose them from the column names.
                        </td>
                      </tr>
                    )}
                    {rows.map((row) => (
                      <tr key={row._id}>
                        <td className="px-3 py-2">
                          <input
                            value={row.name}
                            onChange={(e) => updateRow(row._id, { name: e.target.value })}
                            placeholder="e.g. order_id"
                            className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                          />
                          <span className="block mt-1 text-[10px] text-slate-400">
                            covers {coverageOf(row)} of {columns.length} tables
                          </span>
                        </td>
                        {columns.map(({ side, table }) => (
                          <td key={`${side}:${table}`} className="px-3 py-2 align-top">
                            <select
                              value={(row[side] || {})[table] || ''}
                              onChange={(e) => setCell(row._id, side, table, e.target.value)}
                              className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                            >
                              <option value="">&mdash;</option>
                              {(schemas[side][table] || []).map((c) => (
                                <option key={c.name} value={c.name}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </td>
                        ))}
                        <td className="px-3 py-2 align-top">
                          <button
                            onClick={() => removeRow(row._id)}
                            title="Remove this common name"
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-3 text-xs text-slate-400">
                A common name only appears in a test case&rsquo;s column dropdown once it covers every table that
                test case selects &mdash; a partly-mapped name would fail at run time on the tables it misses.
              </p>

              {saveError && (
                <div className="flex items-center gap-2 mt-3 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {saveError}
                </div>
              )}

              <div className="flex items-center gap-2 mt-5">
                <button
                  onClick={addRow}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-mastek-primary bg-mastek-primary/10 rounded-lg hover:bg-mastek-primary/20"
                >
                  <Plus className="w-4 h-4" /> Add common name
                </button>
                <button
                  onClick={handleAutoMatch}
                  title="Propose common names by grouping columns whose names match apart from case, underscores and spaces"
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-mastek-primary border border-mastek-primary/40 rounded-lg hover:bg-mastek-primary/10"
                >
                  <Wand2 className="w-4 h-4" /> Auto-match by name
                </button>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-sm font-medium text-slate-500 rounded-lg hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                    {isSaving ? 'Saving...' : 'Save column map'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
