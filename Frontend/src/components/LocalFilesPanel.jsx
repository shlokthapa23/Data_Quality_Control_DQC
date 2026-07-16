import { useEffect, useRef, useState } from 'react';
import { UploadCloud, FileText, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { fetchLocalFiles, uploadLocalFile, deleteLocalFile } from '../api';

export default function LocalFilesPanel({ connector }) {
  const [files, setFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [displayName, setDisplayName] = useState('');
  const [isUploading, setIsUploading] = useState(false);
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
    try {
      await uploadLocalFile(connector.id, file, displayName || undefined);
      setDisplayName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (tableId) => {
    await deleteLocalFile(connector.id, tableId);
    load();
  };

  return (
    <div className="border-t border-slate-100 bg-slate-50 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
        Uploaded Files
      </h4>

      <div className="flex items-center gap-2 mb-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.parquet"
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
        <div className="flex items-center gap-2 text-sm text-red-600 mb-3">
          <AlertCircle className="w-4 h-4" /> {error}
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
