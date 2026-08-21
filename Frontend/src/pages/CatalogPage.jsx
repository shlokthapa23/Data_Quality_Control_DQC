import { useEffect, useState } from 'react';
import { Search, RefreshCw, Loader2, Plug, Trash2, X } from 'lucide-react';
import { fetchCatalog, fetchConnectors, deleteCatalogAsset, deleteCatalogAssets } from '../api';
import AssetDetailModal from '../components/catalog/AssetDetailModal';
import { useConfirm } from '../components/common/confirmContext';

const TYPE_BADGE_COLOR = {
  Lakehouse: 'bg-emerald-100 text-emerald-700',
  Warehouse: 'bg-emerald-100 text-emerald-700',
  Notebook: 'bg-purple-100 text-purple-700',
  Report: 'bg-amber-100 text-amber-700',
  SemanticModel: 'bg-sky-100 text-sky-700',
};

export default function CatalogPage() {
  const confirmDialog = useConfirm();
  const [connectors, setConnectors] = useState([]);
  const [connectorId, setConnectorId] = useState('');
  const [assets, setAssets] = useState([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  // Bulk-delete: off by default (a bin icon in the toolbar turns it on) so
  // the ordinary click-a-row-to-open-it behavior is never in the way of
  // multi-select for someone who only ever deletes one at a time.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  useEffect(() => {
    fetchConnectors().then((data) => {
      setConnectors(data);
      if (data.length > 0) setConnectorId(data[0].id);
    });
  }, []);

  const load = () => {
    if (!connectorId) { setAssets([]); setIsLoading(false); return; }
    setIsLoading(true);
    fetchCatalog({ search, type: typeFilter, connectorId })
      .then((data) => {
        setAssets(data.assets);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  };

  useEffect(load, [search, typeFilter, connectorId]);

  // Deletes only the harvested METADATA record, never the real Lakehouse/
  // table/file it describes - the confirm dialog says so explicitly, since
  // "delete" reads as destructive and this codebase never lets an ambiguous
  // delete go through on a bare "are you sure?" (see ConnectPage's connector
  // delete for the same principle with real cascading consequences).
  const handleDelete = async (asset) => {
    const ok = await confirmDialog(
      `Remove "${asset.name}" from the catalog?\n\n`
      + 'This only forgets what was recorded here - it does NOT delete the actual '
      + 'Lakehouse, table, or file in Fabric/local storage. If it\'s used in Test Data '
      + 'Preparation, that page will show it as "not harvested" again until you re-harvest it.',
      { tone: 'danger', confirmLabel: 'Remove' },
    );
    if (!ok) return;
    setDeleteError(null);
    setDeletingId(asset.id);
    try {
      await deleteCatalogAsset(asset.id);
      if (selectedAssetId === asset.id) setSelectedAssetId(null);
      load();
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const toggleSelectMode = () => {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Same "metadata only, never the real data" message as the single-row
  // delete, pluralised - one confirm covers the whole batch rather than one
  // dialog per row, since that's the entire point of selecting several.
  const handleBulkDelete = async () => {
    const count = selectedIds.size;
    if (count === 0) return;
    const ok = await confirmDialog(
      `Remove ${count} harvested record${count === 1 ? '' : 's'} from the catalog?\n\n`
      + 'This only forgets what was recorded here - it does NOT delete the actual '
      + 'Lakehouse(s), table(s), or file(s) in Fabric/local storage. Any of them used in Test '
      + 'Data Preparation will show as "not harvested" again until re-harvested.',
      { tone: 'danger', confirmLabel: 'Remove' },
    );
    if (!ok) return;
    setDeleteError(null);
    setIsBulkDeleting(true);
    try {
      await deleteCatalogAssets([...selectedIds]);
      if (selectedIds.has(selectedAssetId)) setSelectedAssetId(null);
      setSelectedIds(new Set());
      setSelectMode(false);
      load();
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const typeCounts = assets.reduce((acc, a) => {
    acc[a.type] = (acc[a.type] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-800">
          Catalog Viewer <span className="text-slate-400 font-normal">({assets.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleSelectMode}
            title={selectMode ? 'Exit selection mode' : 'Select several to delete together'}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg ${
              selectMode
                ? 'bg-red-50 text-red-600 border-red-300 hover:bg-red-100'
                : 'text-slate-600 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {selectMode ? <X className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
            {selectMode ? 'Cancel' : 'Select'}
          </button>
          <button
            onClick={load}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {selectMode && (
        <div className="flex items-center gap-3 mb-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={assets.length > 0 && selectedIds.size === assets.length}
              onChange={(e) => setSelectedIds(e.target.checked ? new Set(assets.map((a) => a.id)) : new Set())}
              className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent"
            />
            Select all {assets.length}
          </label>
          <span className="text-xs text-slate-500">
            {selectedIds.size} selected
          </span>
          <button
            onClick={handleBulkDelete}
            disabled={selectedIds.size === 0 || isBulkDeleting}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {isBulkDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Delete {selectedIds.size} selected
          </button>
        </div>
      )}

      <label className="flex items-center gap-3 mb-4 max-w-sm">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0 flex items-center gap-1.5">
          <Plug className="w-3.5 h-3.5" /> Connector
        </span>
        <select
          value={connectorId}
          onChange={(e) => { setConnectorId(e.target.value); setSelectedIds(new Set()); }}
          className="flex-1 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {connectors.length === 0 && <option value="">No connectors configured</option>}
          {connectors.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>

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
        {deleteError && <p className="text-sm text-red-600 px-6 pt-4">{deleteError}</p>}

        {!isLoading && !error && (
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                {selectMode && <th className="px-4 py-3 font-medium w-8" />}
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Owner</th>
                <th className="px-6 py-3 font-medium">Harvested</th>
                {!selectMode && <th className="px-6 py-3 font-medium" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assets.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => (selectMode ? toggleSelected(a.id) : setSelectedAssetId(a.id))}
                  className="hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  {selectMode && (
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(a.id)}
                        onChange={() => toggleSelected(a.id)}
                        className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent"
                      />
                    </td>
                  )}
                  <td className="px-6 py-3 font-medium text-slate-800">{a.name}</td>
                  <td className="px-6 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      TYPE_BADGE_COLOR[a.type] || 'bg-slate-100 text-slate-600'
                    }`}>
                      {a.type}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-slate-500">{a.owner || '--'}</td>
                  <td className="px-6 py-3 text-slate-400">
                    {new Date(a.harvested_at).toLocaleString()}
                  </td>
                  {!selectMode && (
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(a); }}
                        disabled={deletingId === a.id}
                        title="Remove this harvested record from the catalog"
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md disabled:opacity-50"
                      >
                        {deletingId === a.id
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </td>
                  )}
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