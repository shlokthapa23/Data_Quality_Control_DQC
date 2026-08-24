import { useState } from 'react';
import { X, Plus, Trash2, Loader2, AlertCircle, CheckCircle2, Download, FlaskConical } from 'lucide-react';
import { finalizeSyntheticTable, downloadSyntheticTable } from '../../api';

const INITIAL_ROW_COUNT = 25;

const emptyRow = (columns) => Object.fromEntries(columns.map((c) => [c.name, '']));

/**
 * Draft-then-finalize flow for a personal synthetic test table.
 *
 * Nothing is created until Finalize is pressed - everything before that is
 * pure local state. The tester picked a real table's SCHEMA (columns/types
 * only, never real rows - `source.columns` came from the same live schema
 * fetch the rest of the app already trusts) as a template; they fill in
 * however many rows they actually want, add/remove freely, then Finalize
 * writes it into their personal test-data connector in one shot.
 */
export default function TestDataDraftModal({ source, onClose, onCreated }) {
  const [displayName, setDisplayName] = useState(`${source.tableName}_test_data`);
  const [rows, setRows] = useState(() =>
    Array.from({ length: INITIAL_ROW_COUNT }, () => emptyRow(source.columns)));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { id, connector_id, row_count, warnings }
  const [isDownloading, setIsDownloading] = useState(false);

  const updateCell = (rowIndex, colName, value) => {
    setRows((rs) => rs.map((r, i) => (i === rowIndex ? { ...r, [colName]: value } : r)));
  };

  const addRow = () => setRows((rs) => [...rs, emptyRow(source.columns)]);
  const removeRow = (rowIndex) => setRows((rs) => rs.filter((_, i) => i !== rowIndex));

  // Rows that are still entirely blank aren't sent - a tester who asked for
  // 25 starting rows and only filled in 6 almost certainly means 6, not 25
  // rows of empty strings.
  const nonEmptyRows = rows.filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== ''));

  const handleFinalize = async () => {
    if (!displayName.trim()) { setError('Give this test table a name'); return; }
    setIsSaving(true);
    setError(null);
    try {
      const created = await finalizeSyntheticTable({
        displayName: displayName.trim(),
        source: { connectorId: source.connectorId, containerId: source.containerId, tableName: source.tableName },
        rows: nonEmptyRows,
      });
      setResult(created);
      onCreated?.(created);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const { blob, filename } = await downloadSyntheticTable(result.connector_id, result.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 sticky top-0 bg-white z-10">
          <div>
            <span className="font-semibold text-slate-800 flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-mastek-primary" /> Create Test Data
            </span>
            <p className="text-xs text-slate-400 mt-0.5">
              Cloning <span className="font-mono text-slate-600">{source.tableName}</span>&rsquo;s columns only
              &mdash; no real rows are ever read. Fill in the rows you need, then Finalize to generate the table
              in your own personal test-data connector.
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded-lg shrink-0">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-6">
          {result ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 text-sm text-mastek-success bg-mastek-success/10 border border-mastek-success/30 rounded-lg px-3 py-2.5">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">
                    &ldquo;{result.display_name}&rdquo; created with {result.row_count} row{result.row_count === 1 ? '' : 's'}.
                  </p>
                  <p className="text-xs mt-0.5 text-mastek-success/80">
                    It&rsquo;s in your personal test-data connector now &mdash; usable as the source or
                    destination of any test layer, same as any other Local table.
                  </p>
                </div>
              </div>
              {result.warnings?.length > 0 && (
                <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <ul className="space-y-0.5">
                    {result.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDownload}
                  disabled={isDownloading}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-mastek-primary border border-mastek-primary/40 rounded-lg hover:bg-mastek-primary/10 disabled:opacity-50"
                >
                  {isDownloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  Download CSV
                </button>
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Name for this test table"
                className="w-full mb-4 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
              />

              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-slate-500">
                  {rows.length} row{rows.length === 1 ? '' : 's'} &mdash; {nonEmptyRows.length} with at least one value filled in
                </p>
                <button
                  onClick={addRow}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-mastek-primary bg-mastek-primary/10 rounded-md hover:bg-mastek-primary/20"
                >
                  <Plus className="w-3.5 h-3.5" /> Add row
                </button>
              </div>

              <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-[50vh] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs font-medium text-slate-400 border-b border-slate-100 sticky top-0 bg-white z-10">
                    <tr>
                      <th className="px-2 py-2 w-8">#</th>
                      {source.columns.map((c) => (
                        <th key={c.name} className="px-2 py-2 min-w-[9rem]">
                          <span className="block font-mono text-slate-600 truncate">{c.name}</span>
                          <span className="text-[10px] uppercase tracking-wider text-slate-400">{c.data_type}</span>
                        </th>
                      ))}
                      <th className="px-2 py-2 w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1.5 text-xs text-slate-400 tabular-nums">{i + 1}</td>
                        {source.columns.map((c) => (
                          <td key={c.name} className="px-1.5 py-1">
                            <input
                              value={row[c.name] ?? ''}
                              onChange={(e) => updateCell(i, c.name, e.target.value)}
                              className="w-full px-2 py-1 text-sm font-mono border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                            />
                          </td>
                        ))}
                        <td className="px-2 py-1.5">
                          <button
                            onClick={() => removeRow(i)}
                            title="Remove this row"
                            className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {error && (
                <div className="flex items-center gap-2 mt-3 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 mt-5">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-medium text-slate-500 rounded-lg hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleFinalize}
                  disabled={isSaving || nonEmptyRows.length === 0}
                  title={nonEmptyRows.length === 0 ? 'Fill in at least one row first' : undefined}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
                  {isSaving ? 'Generating…' : 'Finalize & Generate Test Data'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
