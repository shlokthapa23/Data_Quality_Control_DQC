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
  // What the last upload produced, so the tester can see the file actually
  // landed and - for XML - which element the rows were taken from.
  const [lastUpload, setLastUpload] = useState(null);
  const [isReingesting, setIsReingesting] = useState(false);
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
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setError(null);
    setLastUpload(null);
    try {
      const created = await uploadLocalFile(connector.id, file, displayName || undefined);
      setLastUpload(created);
      setDisplayName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  // XML has no rows of its own, so the record element is a guess. Re-reading
  // uses the upload already on disk rather than asking for the file again.
  const handleReingest = async (element) => {
    setIsReingesting(true);
    setError(null);
    try {
      setLastUpload(await reingestLocalTable(connector.id, lastUpload.id, element));
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsReingesting(false);
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
        CSV, TSV, TXT, JSON, NDJSON, Parquet or XML. Whatever the format, it becomes a table you
        can test with ordinary SQL &mdash; so you can check a file&rsquo;s quality before loading
        it anywhere.
      </p>

      <div className="flex items-center gap-2 mb-4">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED}
          className="text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-white file:border file:border-slate-300 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50"
        />
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Optional display name"
          className="px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
        />
        <button
          onClick={handleUpload}
          disabled={isUploading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 shrink-0"
        >
          {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
          Upload
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 mb-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {lastUpload && (
        <div className="mb-3 rounded-lg border border-mastek-success/30 bg-mastek-success/5 px-3 py-2 space-y-1.5">
          <p className="flex items-center gap-2 text-sm text-slate-700">
            <CheckCircle2 className="w-4 h-4 text-mastek-success shrink-0" />
            <span className="font-mono text-xs">{lastUpload.duckdb_table_name}</span>
            {/* ?? not ||: a 0-row file is exactly what a tester needs to see. */}
            <span className="text-xs text-slate-500">
              {(lastUpload.row_count ?? 0).toLocaleString()} rows &middot; {lastUpload.column_count} columns
            </span>
          </p>
          {lastUpload.xml_record_element && (
            <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500">
              <span>
                Rows taken from <code className="font-mono text-slate-700">
                  &lt;{lastUpload.xml_record_element}&gt;
                </code>.
              </span>
              {(lastUpload.xml_candidates || []).length > 1 && (
                <>
                  <span>Not right?</span>
                  <select
                    value={lastUpload.xml_record_element}
                    disabled={isReingesting}
                    onChange={(e) => handleReingest(e.target.value)}
                    className="px-1.5 py-0.5 text-xs border border-slate-300 rounded disabled:opacity-50"
                  >
                    {lastUpload.xml_candidates.map((c) => (
                      <option key={c} value={c}>&lt;{c}&gt;</option>
                    ))}
                  </select>
                  {isReingesting && <Loader2 className="w-3 h-3 animate-spin" />}
                </>
              )}
            </div>
          )}
        </div>
      )}

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
