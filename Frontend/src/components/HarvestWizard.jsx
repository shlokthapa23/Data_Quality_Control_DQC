import { useEffect, useState } from 'react';
import {
  Database, Table2, FileText, BarChart3, NotebookText, Folder,
  Loader2, AlertCircle, CheckCircle2, DownloadCloud,
} from 'lucide-react';
import {
  fetchConnectors, fetchConnectorItems, runHarvest,
  fetchHarvestSchedules, createHarvestSchedule, updateHarvestSchedule,
  deleteHarvestSchedule, fetchHarvestScheduleEvents,
} from '../api';
import SchedulesSection from './SchedulesSection';

const CATEGORY_ICON = {
  Lakehouse: Database,
  Warehouse: Table2,
  SemanticModel: BarChart3,
  Report: FileText,
  Notebook: NotebookText,
};

function CategoryIcon({ type, className }) {
  const Icon = CATEGORY_ICON[type] || Folder;
  return <Icon className={className} />;
}

function groupByType(items) {
  const groups = {};
  for (const item of items) {
    if (!groups[item.type]) groups[item.type] = [];
    groups[item.type].push(item);
  }
  return groups;
}

export default function HarvestWizard() {
  const [connectors, setConnectors] = useState([]);
  const [connectorId, setConnectorId] = useState('');

  const [items, setItems] = useState([]);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [itemsError, setItemsError] = useState(null);

  const [checkedKeys, setCheckedKeys] = useState(new Set());
  const [mode, setMode] = useState('incremental');

  const [isHarvesting, setIsHarvesting] = useState(false);
  const [result, setResult] = useState(null);
  const [harvestError, setHarvestError] = useState(null);

  useEffect(() => {
    fetchConnectors().then((data) => {
      setConnectors(data);
      if (data.length > 0) setConnectorId(data[0].id);
    });
  }, []);

  useEffect(() => {
    if (!connectorId) return;
    setIsLoadingItems(true);
    setItemsError(null);
    setCheckedKeys(new Set());
    setResult(null);

    fetchConnectorItems(connectorId)
      .then((data) => {
        setItems(data.items);
        setIsLoadingItems(false);
      })
      .catch((err) => {
        setItemsError(err.message);
        setIsLoadingItems(false);
      });
  }, [connectorId]);

  const toggleItem = (item) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
      return next;
    });
  };

  const handleHarvest = async () => {
    const selectedItems = items.filter((i) => checkedKeys.has(i.id));
    setIsHarvesting(true);
    setHarvestError(null);
    setResult(null);
    try {
      const res = await runHarvest({ connectorId, mode, items: selectedItems });
      setResult(res);
    } catch (err) {
      setHarvestError(err.message);
    } finally {
      setIsHarvesting(false);
    }
  };

  const groups = groupByType(items);
  const selectedCount = checkedKeys.size;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
        <h2 className="font-semibold text-slate-800 mb-1">Harvest New Metadata</h2>
        <p className="text-sm text-slate-500 mb-5">
          Select a connector, choose which assets to pull in, then run the harvest.
        </p>

        {/* Step 1: connector */}
        <label className="block mb-5">
          <span className="block text-xs font-medium text-slate-500 mb-1">Connector</span>
          <select
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {connectors.length === 0 && <option value="">No connectors configured</option>}
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>

        {/* Schedules for this connector — harvests everything visible at fire time */}
        {connectorId && (
          <SchedulesSection
            parentId={connectorId}
            kind="harvest"
            fetchList={fetchHarvestSchedules}
            create={createHarvestSchedule}
            update={updateHarvestSchedule}
            remove={deleteHarvestSchedule}
            fetchEvents={fetchHarvestScheduleEvents}
            createExtras={{ mode: 'incremental' }}
          />
        )}

        {/* Step 2: choose assets */}
        {isLoadingItems && (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading assets...
          </div>
        )}

        {itemsError && (
          <div className="flex items-center gap-2 text-sm text-red-600 py-4">
            <AlertCircle className="w-4 h-4" /> {itemsError}
          </div>
        )}

        {!isLoadingItems && !itemsError && items.length > 0 && (
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-80 overflow-y-auto mb-5">
            {Object.entries(groups).map(([type, groupItems]) => (
              <div key={type} className="p-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  <CategoryIcon type={type} className="w-3.5 h-3.5" />
                  {type} ({groupItems.length})
                </div>
                <div className="space-y-1">
                  {groupItems.map((item) => (
                    <label
                      key={item.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checkedKeys.has(item.id)}
                        onChange={() => toggleItem(item)}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-slate-700 truncate">{item.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Step 3: mode + run */}
        {!isLoadingItems && !itemsError && items.length > 0 && (
          <>
            <div className="flex items-center gap-6 mb-5">
              <span className="text-xs font-medium text-slate-500">Mode:</span>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  checked={mode === 'incremental'}
                  onChange={() => setMode('incremental')}
                  className="text-blue-600 focus:ring-blue-500"
                />
                Incremental <span className="text-slate-400">(append)</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  checked={mode === 'full_refresh'}
                  onChange={() => setMode('full_refresh')}
                  className="text-blue-600 focus:ring-blue-500"
                />
                Full Refresh <span className="text-slate-400">(replace)</span>
              </label>
            </div>

            <button
              onClick={handleHarvest}
              disabled={selectedCount === 0 || isHarvesting}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isHarvesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
              Harvest {selectedCount > 0 ? `(${selectedCount})` : ''}
            </button>
          </>
        )}

        {harvestError && (
          <div className="flex items-center gap-2 text-sm text-red-600 mt-4">
            <AlertCircle className="w-4 h-4" /> {harvestError}
          </div>
        )}

        {result && (
          <div className="mt-5 p-4 rounded-lg bg-emerald-50 text-sm text-emerald-700 space-y-1">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="w-4 h-4" />
              Harvested {result.harvested.length} asset(s)
            </div>
            {result.errors.length > 0 && (
              <div className="text-red-600">
                {result.errors.length} failed: {result.errors.map((e) => e.item).join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}