import { useMemo, useRef, useState } from 'react';
import { X, Upload, AlertCircle, CheckCircle2, Loader2, DatabaseZap } from 'lucide-react';
import { insertRowsIntoFabricTable, fetchFabricInsertJob } from '../../api';
import { useConfirm } from '../common/confirmContext';
import { pollJob } from '../../pollJob';

// Minimal RFC-4180-ish CSV parser - handles quoted fields (with embedded
// commas/newlines/escaped quotes), which is all this needs to round-trip
// files this same app produced (see TestDataDraftModal's buildCsv). Not a
// general-purpose CSV library; a malformed hand-edited file just parses
// less usefully rather than throwing, which is fine for a preview step the
// tester reviews before confirming anything.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return { header: [], rows: [] };
  const [header, ...body] = rows;
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
}

/**
 * Beside the filter bar on the Test Data Preparation page: the tester picks
 * a target table already listed there, uploads a CSV (typically one they
 * downloaded from TestDataDraftModal earlier), previews the parsed rows,
 * then confirms a real INSERT into that Fabric table. Same write path and
 * same explicit-confirm gating as TestDataDraftModal's own "Insert into
 * Fabric table" button - this is just the other entry point into it, for a
 * CSV the tester built or edited outside the app.
 */
export default function UploadTestDataModal({ connectorId, containerId, tables, onClose }) {
  const confirm = useConfirm();
  const [tableName, setTableName] = useState(tables?.[0]?.name || '');
  const [parsed, setParsed] = useState(null); // { header, rows }
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState(null);
  const [isInserting, setIsInserting] = useState(false);
  const [inserted, setInserted] = useState(null);
  const [insertStatus, setInsertStatus] = useState(null);
  const fileInputRef = useRef(null);

  const selectedTable = useMemo(() => tables?.find((t) => t.name === tableName), [tables, tableName]);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setInserted(null);
    setFileName(file.name);
    file.text().then((text) => setParsed(parseCsv(text))).catch(() => setError('Could not read that file as text.'));
  };

  const handleInsert = async () => {
    if (!parsed || parsed.rows.length === 0) { setError('Upload a CSV with at least one row first.'); return; }
    if (!selectedTable) { setError('Pick a target table first.'); return; }
    const ok = await confirm(
      `Insert ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} from "${fileName}" directly into ` +
        `the real Fabric table "${tableName}"? This runs a Fabric notebook job and can take a few minutes - ` +
        `Fabric's SQL endpoint can't write to a Lakehouse table directly. This cannot be undone from here.`,
      { confirmLabel: 'Insert rows', tone: 'danger' },
    );
    if (!ok) return;
    setIsInserting(true);
    setError(null);
    setInsertStatus('Starting the Fabric notebook job…');
    try {
      const started = await insertRowsIntoFabricTable(connectorId, { containerId, tableName, rows: parsed.rows });
      const run = await pollJob(
        () => fetchFabricInsertJob(connectorId, started.notebook_item_id, started.job_id, {
          containerId: started.container_id, stagingPath: started.staging_path, tableName, rowCount: started.row_count,
        }),
        { onTick: (r) => setInsertStatus(r.is_running ? 'Running in Fabric… (Spark can take a few minutes to start)' : null) },
      );
      if (run.status !== 'Completed') throw new Error(run.failure_reason || `Fabric job ended with status "${run.status}"`);
      setInserted(started.row_count);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsInserting(false);
      setInsertStatus(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <span className="font-semibold text-slate-800 flex items-center gap-2">
            <Upload className="w-4 h-4 text-mastek-primary" /> Upload Test Data
          </span>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded-lg">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-xs text-slate-400">
            Upload a CSV of generated test data (columns must match the target table's own columns) and insert
            it directly into a real Fabric table &mdash; the same write path as &ldquo;Insert into Fabric
            table&rdquo;, gated behind the same confirmation.
          </p>

          <label className="block text-xs font-medium text-slate-500">
            Target table
            <select
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              className="w-full mt-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
            >
              {(tables || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </label>

          <label className="block text-xs font-medium text-slate-500">
            CSV file
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="w-full mt-1 text-sm text-slate-600"
            />
          </label>

          {parsed && (
            <p className="text-xs text-slate-500">
              Parsed {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'}, {parsed.header.length} column
              {parsed.header.length === 1 ? '' : 's'} from &ldquo;{fileName}&rdquo;.
            </p>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          {inserted != null && (
            <div className="flex items-center gap-2 text-sm text-mastek-success bg-mastek-success/10 border border-mastek-success/30 rounded-lg px-3 py-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" /> Inserted {inserted} row{inserted === 1 ? '' : 's'} into &ldquo;{tableName}&rdquo;.
            </div>
          )}

          {insertStatus && <p className="text-xs text-slate-500">{insertStatus}</p>}

          <div className="flex items-center justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-500 rounded-lg hover:bg-slate-100">
              {inserted != null ? 'Done' : 'Cancel'}
            </button>
            {inserted == null && (
              <button
                onClick={handleInsert}
                disabled={isInserting || !parsed}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:brightness-110 disabled:opacity-50"
              >
                {isInserting ? <Loader2 className="w-4 h-4 animate-spin" /> : <DatabaseZap className="w-4 h-4" />}
                Insert into Fabric table
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
