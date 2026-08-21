import { useEffect, useState } from 'react';
import {
  CalendarClock, RefreshCw, Loader2, AlertCircle, Trash2, ListChecks, DownloadCloud, X, Workflow,
} from 'lucide-react';
import {
  fetchAllSchedules,
  updateSuiteSchedule, deleteSuiteSchedule,
  updateHarvestSchedule, deleteHarvestSchedule,
  updatePipelineSchedule, deletePipelineSchedule,
} from '../api';
import { humanizeTrigger, STATUS_STYLES } from '../scheduleFormat';
import { useConfirm } from '../components/common/confirmContext';

function StatusBadges({ sched }) {
  return (
    <>
      {sched.last_status && (
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLES[sched.last_status] || 'bg-slate-100 text-slate-500'}`}>
          {sched.last_status}
        </span>
      )}
      {sched.misfire_count > 0 && (
        <span
          title={`${sched.misfire_count} missed fires — consider a longer interval`}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700"
        >
          ⚠ {sched.misfire_count}
        </span>
      )}
    </>
  );
}

function ActiveToggle({ active, onToggle }) {
  return (
    <button
      onClick={onToggle}
      role="switch"
      aria-checked={active}
      title={active ? 'Active — click to pause' : 'Paused — click to activate'}
      className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors shrink-0 ${
        active ? 'bg-mastek-primary' : 'bg-slate-300'
      }`}
    >
      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
        active ? 'translate-x-4' : 'translate-x-0.5'
      }`} />
    </button>
  );
}

export default function SchedulesDashboard() {
  const confirmDialog = useConfirm();
  const [suiteSchedules, setSuiteSchedules] = useState([]);
  const [harvestSchedules, setHarvestSchedules] = useState([]);
  const [pipelineSchedules, setPipelineSchedules] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => { if (!cancelled) setIsLoading(true); })
      .then(() => fetchAllSchedules())
      .then((data) => {
        if (cancelled) return;
        setSuiteSchedules(data.suite_schedules || []);
        setHarvestSchedules(data.harvest_schedules || []);
        setPipelineSchedules(data.pipeline_schedules || []);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshTick]);

  const reload = () => setRefreshTick((t) => t + 1);

  const handleToggleSuite = async (sched) => {
    try {
      await updateSuiteSchedule(sched.id, { active: !sched.active });
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteSuite = async (sched) => {
    if (!(await confirmDialog(`Delete this schedule for "${sched.suite_name || 'suite'}"?`, { tone: 'danger', confirmLabel: 'Delete' }))) return;
    try {
      await deleteSuiteSchedule(sched.id);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleToggleHarvest = async (sched) => {
    try {
      await updateHarvestSchedule(sched.id, { active: !sched.active });
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteHarvest = async (sched) => {
    if (!(await confirmDialog(`Delete this schedule for "${sched.connector_name || 'connector'}"?`, { tone: 'danger', confirmLabel: 'Delete' }))) return;
    try {
      await deleteHarvestSchedule(sched.id);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTogglePipeline = async (sched) => {
    try {
      await updatePipelineSchedule(sched.id, { active: !sched.active });
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeletePipeline = async (sched) => {
    if (!(await confirmDialog(`Delete this schedule for "${sched.pipeline_name || 'pipeline'}"?`, { tone: 'danger', confirmLabel: 'Delete' }))) return;
    try {
      await deletePipelineSchedule(sched.id);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const totalCount = suiteSchedules.length + harvestSchedules.length + pipelineSchedules.length;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <CalendarClock className="w-5 h-5 text-mastek-primary" />
          Test Suite &amp; Harvest Schedule
        </h2>
        <button
          onClick={reload}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-slate-400 hover:text-slate-600"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500 p-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      )}

      {!isLoading && totalCount === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-12 text-center">
          <CalendarClock className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">
            No schedules yet — create one from a test suite's detail page on{' '}
            <span className="font-medium text-slate-700">Test Suite Execution</span>, from the{' '}
            <span className="font-medium text-slate-700">Harvest</span> wizard, or from{' '}
            <span className="font-medium text-slate-700">Test Data Preparation</span>.
          </p>
        </div>
      )}

      {!isLoading && suiteSchedules.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-mastek-primary" />
            <h3 className="font-semibold text-sm text-slate-700">Test Suite Schedules ({suiteSchedules.length})</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-left">
              <tr>
                <th className="px-5 py-2 font-medium">Suite</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Next fire</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Active</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {suiteSchedules.map((sched) => {
                const nextFire = sched.active && sched.next_fires && sched.next_fires[0];
                return (
                  <tr key={sched.id} className={sched.active ? '' : 'opacity-60'}>
                    <td className="px-5 py-3 min-w-0 max-w-xs">
                      <p className="font-medium text-slate-700 truncate">{sched.suite_name || '(deleted suite)'}</p>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">{humanizeTrigger(sched)}</td>
                    <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {nextFire ? new Date(nextFire).toLocaleString() : (sched.active ? '—' : 'Inactive')}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5"><StatusBadges sched={sched} /></div>
                    </td>
                    <td className="px-3 py-3">
                      <ActiveToggle active={sched.active} onToggle={() => handleToggleSuite(sched)} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => handleDeleteSuite(sched)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && harvestSchedules.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-2">
            <DownloadCloud className="w-4 h-4 text-mastek-primary" />
            <h3 className="font-semibold text-sm text-slate-700">Harvest Schedules ({harvestSchedules.length})</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-left">
              <tr>
                <th className="px-5 py-2 font-medium">Connector</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">Items</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Next fire</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Active</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {harvestSchedules.map((sched) => {
                const nextFire = sched.active && sched.next_fires && sched.next_fires[0];
                return (
                  <tr key={sched.id} className={sched.active ? '' : 'opacity-60'}>
                    <td className="px-5 py-3 min-w-0 max-w-xs">
                      <p className="font-medium text-slate-700 truncate">{sched.connector_name || '(deleted connector)'}</p>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap capitalize">{sched.mode || '—'}</td>
                    <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {Array.isArray(sched.selected_items) ? `${sched.selected_items.length} item${sched.selected_items.length === 1 ? '' : 's'}` : 'all (legacy)'}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">{humanizeTrigger(sched)}</td>
                    <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {nextFire ? new Date(nextFire).toLocaleString() : (sched.active ? '—' : 'Inactive')}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5"><StatusBadges sched={sched} /></div>
                    </td>
                    <td className="px-3 py-3">
                      <ActiveToggle active={sched.active} onToggle={() => handleToggleHarvest(sched)} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => handleDeleteHarvest(sched)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && pipelineSchedules.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mt-6">
          <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-2">
            <Workflow className="w-4 h-4 text-mastek-primary" />
            <h3 className="font-semibold text-sm text-slate-700">Pipeline Schedules ({pipelineSchedules.length})</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-left">
              <tr>
                <th className="px-5 py-2 font-medium">Pipeline</th>
                <th className="px-3 py-2 font-medium">Connector</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Next fire</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Active</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pipelineSchedules.map((sched) => {
                const nextFire = sched.active && sched.next_fires && sched.next_fires[0];
                return (
                  <tr key={sched.id} className={sched.active ? '' : 'opacity-60'}>
                    <td className="px-5 py-3 min-w-0 max-w-xs">
                      <p className="font-medium text-slate-700 truncate">{sched.pipeline_name || '(unnamed pipeline)'}</p>
                      <p className="text-[11px] text-slate-400 font-mono truncate">{sched.pipeline_item_id}</p>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500 truncate">{sched.connector_name || '(deleted connector)'}</td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">{humanizeTrigger(sched)}</td>
                    <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {nextFire ? new Date(nextFire).toLocaleString() : (sched.active ? '—' : 'Inactive')}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1.5"><StatusBadges sched={sched} /></div>
                    </td>
                    <td className="px-3 py-3">
                      <ActiveToggle active={sched.active} onToggle={() => handleTogglePipeline(sched)} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => handleDeletePipeline(sched)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
