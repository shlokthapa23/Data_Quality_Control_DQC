import { useEffect, useState } from 'react';
import { Search, RefreshCw, Loader2 } from 'lucide-react';
import { fetchCatalog } from '../api';
import AssetDetailModal from './AssetDetailModal';

const TYPE_BADGE_COLOR = {
  Lakehouse: 'bg-emerald-100 text-emerald-700',
  Warehouse: 'bg-emerald-100 text-emerald-700',
  Notebook: 'bg-purple-100 text-purple-700',
  Report: 'bg-amber-100 text-amber-700',
  SemanticModel: 'bg-sky-100 text-sky-700',
};

export default function CatalogPage() {
  const [assets, setAssets] = useState([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedAssetId, setSelectedAssetId] = useState(null);

  const load = () => {
    setIsLoading(true);
    fetchCatalog({ search, type: typeFilter })
      .then((data) => {
        setAssets(data.assets);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  };

  useEffect(load, [search, typeFilter]);

  const typeCounts = assets.reduce((acc, a) => {
    acc[a.type] = (acc[a.type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-800">
          Harvested Catalog <span className="text-slate-400 font-normal">({assets.length})</span>
        </h2>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search metadata..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setTypeFilter(null)}
            className={`px-3 py-1 text-xs font-medium rounded-full ${
              !typeFilter ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            All
          </button>
          {Object.entries(typeCounts).map(([type, count]) => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={`px-3 py-1 text-xs font-medium rounded-full ${
                typeFilter === type ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {type} {count}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-500 p-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        )}
        {error && <p className="text-sm text-red-600 p-6">{error}</p>}

        {!isLoading && !error && (
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Owner</th>
                <th className="px-6 py-3 font-medium">Glossary</th>
                <th className="px-6 py-3 font-medium">Harvested</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assets.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => setSelectedAssetId(a.id)}
                  className="hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <td className="px-6 py-3 font-medium text-slate-800">{a.name}</td>
                  <td className="px-6 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      TYPE_BADGE_COLOR[a.type] || 'bg-slate-100 text-slate-600'
                    }`}>
                      {a.type}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-slate-500">{a.owner || '--'}</td>
                  <td className="px-6 py-3">
                    <span className={a.glossary_status === 'Unmapped' ? 'text-slate-400' : 'text-emerald-600'}>
                      {a.glossary_status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-slate-400">
                    {new Date(a.harvested_at).toLocaleString()}
                  </td>
                </tr>
              ))}
              {assets.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-400">
                    Nothing harvested yet - run a harvest job first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {selectedAssetId && (
        <AssetDetailModal assetId={selectedAssetId} onClose={() => setSelectedAssetId(null)} />
      )}
    </div>
  );
}