import { useEffect, useState } from 'react';
import { X, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchCatalogAsset } from '../../api';

function ExpandableTable({ table }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-slate-200 rounded-lg mb-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50"
      >
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        <span className="font-medium text-slate-700">{table.table}</span>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
          {table.kind}
        </span>
        <span className="text-xs text-slate-400">{table.columns.length} cols</span>
      </button>
      {open && (
        <table className="w-full text-xs border-t border-slate-100">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Column</th>
              <th className="text-left px-3 py-1.5 font-medium">Data Type</th>
              <th className="text-left px-3 py-1.5 font-medium">Nullable</th>
              <th className="text-left px-3 py-1.5 font-medium">Default</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.columns.map((c) => (
              <tr key={c.name}>
                <td className="px-3 py-1.5 text-slate-700">{c.name}</td>
                <td className="px-3 py-1.5 text-slate-500">{c.data_type}</td>
                <td className="px-3 py-1.5 text-slate-500">{c.nullable ? 'Yes' : 'No'}</td>
                <td className="px-3 py-1.5 text-slate-400">{c.default ?? '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AssetDetailModal({ assetId, onClose }) {
  const [asset, setAsset] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchCatalogAsset(assetId)
      .then((data) => {
        setAsset(data);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  }, [assetId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 sticky top-0 bg-white">
          <div>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 mr-2">
              {asset?.type || '...'}
            </span>
            <span className="font-semibold text-slate-800">{asset?.name || 'Loading...'}</span>
            <p className="text-xs text-slate-400 mt-0.5">Detailed metadata for this asset</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded-lg">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-6">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}

          {asset && !isLoading && !error && (
            <>
              <div className="mb-6">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Properties</h4>
                <div className="grid grid-cols-2 gap-y-2 text-sm">
                  <span className="text-slate-400">Connector</span>
                  <span className="text-slate-700">{asset.connector_name}</span>
                  <span className="text-slate-400">Type</span>
                  <span className="text-slate-700">{asset.type}</span>
                  <span className="text-slate-400">Owner</span>
                  <span className="text-slate-700">{asset.owner || '--'}</span>
                  <span className="text-slate-400">Glossary</span>
                  <span className="text-slate-700">{asset.glossary_status}</span>
                  <span className="text-slate-400">Harvested</span>
                  <span className="text-slate-700">{new Date(asset.harvested_at).toLocaleString()}</span>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  Schema {asset.schema.length > 0 && `(${asset.schema.length} tables)`}
                </h4>
                {asset.schema.length === 0 && (
                  <p className="text-sm text-slate-400 italic">No tabular schema for this asset type.</p>
                )}
                {asset.schema.map((t) => (
                  <ExpandableTable key={t.table} table={t} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}