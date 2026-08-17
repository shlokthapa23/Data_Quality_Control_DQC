import { useEffect, useRef, useState } from 'react';
import { UploadCloud, FileText, Trash2, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { fetchLocalFiles, uploadLocalFile, deleteLocalFile, reingestLocalTable } from '../../api';

// Kept in step with SUPPORTED_EXTENSIONS in Backend/local_files/db.py. Whatever
// the format, the upload becomes an ordinary DuckDB table - which is the point:
// the same SQL test runs against all of them.
const ACCEPTED = '.csv,.tsv,.txt,.json,.ndjson,.jsonl,.parquet,.xml';

export default function LocalFilesPanel({ connector }) {
  const [files, setFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [displayName, setDisplayName] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  // How far through a batch we are, so 50 files don't look like a hung button.
  const [progress, setProgress] = useState(null); // { done, total, current }
  // One entry per file in the last batch: what landed, or why it didn't. For
  // XML it also carries which element the rows were taken from.
  const [results, setResults] = useState([]);
  const [reingestingId, setReingestingId] = useState(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const fileInputRef = useRef(null);

  const load = () => {
    setIsLoading(true);
    fetchLocalFiles(connector.id)
      .then((data) => {
        setFiles(data.tables);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  };

  useEffect(load, [connector.id]);

  const handleUpload = async () => {
    const selected = [...(fileInputRef.current?.files || [])];
    if (selected.length === 0) return;

    setIsUploading(true);
    setError(null);
    setResults([]);

    // Sequential, deliberately. The uploads all write to one DuckDB file, and
    // picking a free table name and creating it aren't atomic - fired in
    // parallel, two files with similar names can choose the same table and one
    // loses. Sequential also means a batch of 50 reports honest progress and a
    // single bad file doesn't take the rest down with it.
    const collected = [];
    for (let i = 0; i < selected.length; i += 1) {
      const file = selected[i];
      setProgress({ done: i, total: selected.length, current: file.name });
      try {
        // A typed display name only makes sense for a single file; in a batch
        // each file keeps its own name.
        const created = await uploadLocalFile(
          connector.id, file, selected.length === 1 ? (displayName || undefined) : undefined);
        collected.push({ ok: true, filename: file.name, ...created });
      } catch (err) {
        collected.push({ ok: false, filename: file.name, message: err.message });
      }
      setResults([...collected]);
    }

    setProgress(null);
    setDisplayName('');
    setSelectedCount(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
    load();
    setIsUploading(false);
  };

  // XML has no rows of its own, so the record element is a guess. Re-reading
  // uses the upload already on disk rather than asking for the file again.
  const handleReingest = async (result, element) => {
    setReingestingId(result.id);
    setError(null);
    try {
      const updated = await reingestLocalTable(connector.id, result.id, element);
      setResults((prev) => prev.map((r) => (r.id === result.id ? { ...r, ...updated } : r)));
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setReingestingId(null);
    }
  };

  const handleDelete = async (tableId) => {
    await deleteLocalFile(connector.id, tableId);
    load();
  };

  return (
    <div className="border-t border-slate-100 bg-slate-50 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
        Uploaded Files
      </h4>
      <p className="text-[11px] text-slate-400 mb-3">
        CSV, TSV, TXT, JSON, NDJSON, Parquet or XML &mdash; select as many as you like. Whatever
        the format, each becomes a table you can test with ordinary SQL &mdash; so you can check a
        file&rsquo;s quality before loading it anywhere.
      </p>

      <div className="flex items-center gap-2 mb-1">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          onChange={(e) => setSelectedCount(e.target.files?.length || 0)}
          className="text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-white file:border file:border-slate-300 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50"
        />
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          // A single typed name can't apply to a batch; each file keeps its own.
          disabled={selectedCount > 1}
          placeholder={selectedCount > 1 ? 'Each file keeps its own name' : 'Optional display name'}
          className="px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent disabled:bg-slate-100 disabled:text-slate-400"
        />
        <button
          onClick={handleUpload}
          disabled={isUploading || selectedCount === 0}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 shrink-0"
        >
          {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
          {selectedCount > 1 ? `Upload ${selectedCount} files` : 'Upload'}
        </button>
      </div>

      {/* Named file and running count, so a 50-file batch never looks stuck. */}
      {progress && (
        <p className="flex items-center gap-2 text-xs text-slate-500 mb-3">
          <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          Uploading {progress.done + 1} of {progress.total}
          <span className="font-mono truncate">{progress.current}</span>
        </p>
      )}
      {!progress && <div className="mb-3" />}

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 mb-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {results.length > 0 && (() => {
        const failed = results.filter((r) => !r.ok);
        // A batch is reported as a whole: one file failing must be visible
        // without hiding the ones that landed, and vice versa.
        const allOk = failed.length === 0;
        return (
          <div className={`mb-3 rounded-lg border px-3 py-2 space-y-1.5 ${
            allOk ? 'border-mastek-success/30 bg-mastek-success/5' : 'border-amber-200 bg-amber-50'
          }`}>
            {results.length > 1 && (
              <p className="text-xs font-medium text-slate-600">
                {results.length - failed.length} of {results.length} files uploaded
                {failed.length > 0 && <span className="text-amber-700"> &middot; {failed.length} failed</span>}
              </p>
            )}
            <div className="space-y-1 max-h-56 overflow-y-auto">
              {results.map((r) => (
                <div key={r.filename + (r.id || '')}>
                  {r.ok ? (
                    <p className="flex items-center gap-2 text-sm text-slate-700">
                      <CheckCircle2 className="w-4 h-4 text-mastek-success shrink-0" />
                      <span className="font-mono text-xs truncate">{r.duckdb_table_name}</span>
                      {/* ?? not ||: a 0-row file is exactly what a tester needs to see. */}
                      <span className="text-xs text-slate-500 shrink-0">
                        {(r.row_count ?? 0).toLocaleString()} rows &middot; {r.column_count} columns
                      </span>
                    </p>
                  ) : (
                    <p className="flex items-start gap-2 text-sm text-red-600">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span className="min-w-0">
                        <span className="font-mono text-xs">{r.filename}</span>
                        <span className="block text-xs">{r.message}</span>
                      </span>
                    </p>
                  )}

                  {r.ok && r.xml_record_element && (
                    <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500 pl-6">
                      <span>
                        Rows taken from <code className="font-mono text-slate-700">
                          &lt;{r.xml_record_element}&gt;
                        </code>.
                      </span>
                      {(r.xml_candidates || []).length > 1 && (
                        <>
                          <span>Not right?</span>
                          <select
                            value={r.xml_record_element}
                            disabled={reingestingId === r.id}
                            onChange={(e) => handleReingest(r, e.target.value)}
                            className="px-1.5 py-0.5 text-xs border border-slate-300 rounded disabled:opacity-50"
                          >
                            {r.xml_candidates.map((c) => (
                              <option key={c} value={c}>&lt;{c}&gt;</option>
                            ))}
                          </select>
                          {reingestingId === r.id && <Loader2 className="w-3 h-3 animate-spin" />}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading files...
        </div>
      )}

      {!isLoading && (
        <div className="space-y-1.5">
          {files.length === 0 && (
            <p className="text-sm text-slate-400 italic">No files uploaded yet.</p>
          )}
          {files.map((f) => (
            <div key={f.id} className="group flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-sm">
              <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-slate-700 truncate">{f.display_name}</p>
                <p className="text-[11px] text-slate-400 font-mono truncate">{f.duckdb_table_name}</p>
              </div>
              <button
                onClick={() => handleDelete(f.id)}
                className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
