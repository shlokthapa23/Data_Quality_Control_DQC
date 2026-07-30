import { useEffect, useState } from 'react';
import {
  CalendarClock, Plus, Trash2, Loader2, AlertCircle, CheckCircle2,
  X, ChevronDown, ChevronRight,
} from 'lucide-react';
import SchedulePicker from './SchedulePicker';

function humanizeTrigger(sched) {
  if (sched.trigger_type === 'interval') {
    const s = sched.trigger_config?.seconds || 0;
    if (s % 3600 === 0) return `Every ${s / 3600}h`;
    if (s % 60 === 0) return `Every ${s / 60}m`;
    return `Every ${s}s`;
  }
  const expr = sched.trigger_config?.expression || '';
  return `cron: ${expr} (${sched.timezone || 'UTC'})`;
}

const STATUS_STYLES = {
  ran:       'bg-mastek-success/10 text-mastek-success',
  coalesced: 'bg-amber-100 text-amber-700',
  missed:    'bg-amber-100 text-amber-700',
  errored:   'bg-red-100 text-red-700',
};

export default function SchedulesSection({
  parentId,
  fetchList,
  create,
  update,
  remove,
  fetchEvents,
  createExtras, // optional: object passed into create payload (e.g. { mode: 'incremental' } for harvest)
}) {
  const [schedules, setSchedules] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [pickerValue, setPickerValue] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [events, setEvents] = useState({}); // scheduleId -> events[]
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!parentId) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => { if (!cancelled) setIsLoading(true); })
      .then(() => fetchList(parentId))
      .then((data) => {
        if (cancelled) return;
        setSchedules(data);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [parentId, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => setRefreshTick((t) => t + 1);

  const handleAdd = async () => {
    if (!pickerValue) return;
    setIsSaving(true);
    setError(null);
    try {
      await create(parentId, { ...(createExtras || {}), ...pickerValue });
      setIsAdding(false);
      setPickerValue(null);
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleActive = async (sched) => {
    try {
      await update(sched.id, { active: !sched.active });
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (scheduleId) => {
    if (!confirm('Delete this schedule? Past events remain in the log.')) return;
    try {
      await remove(scheduleId);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleExpand = async (sched) => {
    if (expandedId === sched.id) { setExpandedId(null); return; }
    setExpandedId(sched.id);
    if (!events[sched.id]) {
      try {
        const evs = await fetchEvents(sched.id);
        setEvents((prev) => ({ ...prev, [sched.id]: evs }));
      } catch (err) {
        setError(err.message);
      }
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-slate-200">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
          <CalendarClock className="w-3.5 h-3.5" />
          Schedules ({schedules.length})
        </div>
        {!isAdding && (
          <button
            onClick={() => { setIsAdding(true); setPickerValue(null); }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-mastek-primary border border-mastek-primary/40 rounded-md hover:bg-mastek-primary/10"
          >
            <Plus className="w-3.5 h-3.5" /> Add Schedule
          </button>
        )}
      </div>

      {error && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
          <button onClick={() => setError(null)} className="ml-auto text-slate-400 hover:text-slate-600"><X className="w-3 h-3" /></button>
        </div>
      )}

      {isAdding && (
        <div className="border border-slate-200 rounded-lg bg-white p-3 mb-3">
          <SchedulePicker value={pickerValue} onChange={setPickerValue} />
          <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-slate-100">
            <button
              onClick={() => { setIsAdding(false); setPickerValue(null); }}
              className="px-3 py-1.5 text-sm font-medium text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={isSaving || !pickerValue}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-mastek-primary rounded-md hover:bg-mastek-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              Save Schedule
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> Loading schedules…</div>
      )}
      {!isLoading && schedules.length === 0 && !isAdding && (
        <p className="text-xs text-slate-400 italic">No schedules yet — click "Add Schedule" to create one.</p>
      )}

      {schedules.length > 0 && (
        <ul className="space-y-1.5">
          {schedules.map((sched) => {
            const isOpen = expandedId === sched.id;
            const nextFire = sched.active && sched.next_fires && sched.next_fires[0];
            return (
              <li key={sched.id} className={`border border-slate-200 rounded-lg bg-white ${sched.active ? '' : 'opacity-60'}`}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <button onClick={() => handleExpand(sched)} className="text-slate-400 hover:text-slate-600 shrink-0">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-800 truncate">{humanizeTrigger(sched)}</div>
                    <div className="text-xs text-slate-500 truncate">
                      {nextFire ? <>Next: <span className="font-mono">{new Date(nextFire).toLocaleString()}</span></> : (sched.active ? '—' : 'Inactive')}
                    </div>
                  </div>
                  {sched.last_status && (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLES[sched.last_status] || 'bg-slate-100 text-slate-500'}`}>
                      {sched.last_status}
                    </span>
                  )}
                  {sched.misfire_count > 0 && (
                    <span title={`${sched.misfire_count} missed fires — consider a longer interval`} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
                      ⚠ {sched.misfire_count}
                    </span>
                  )}
                  <button
                    onClick={() => handleToggleActive(sched)}
                    role="switch"
                    aria-checked={sched.active}
                    title={sched.active ? 'Active — click to pause' : 'Paused — click to activate'}
                    className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors shrink-0 ${
                      sched.active ? 'bg-mastek-primary' : 'bg-slate-300'
                    }`}
                  >
                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      sched.active ? 'translate-x-4' : 'translate-x-0.5'
                    }`} />
                  </button>
                  <button
                    onClick={() => handleDelete(sched.id)}
                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded shrink-0"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                {isOpen && (
                  <div className="border-t border-slate-100 px-3 py-2 bg-slate-50">
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Recent events</div>
                    {!events[sched.id] && <div className="text-xs text-slate-400">Loading…</div>}
                    {events[sched.id] && events[sched.id].length === 0 && (
                      <div className="text-xs text-slate-400 italic">No events yet — this schedule hasn't fired.</div>
                    )}
                    {events[sched.id] && events[sched.id].length > 0 && (
                      <ul className="text-xs space-y-1">
                        {events[sched.id].slice(0, 10).map((ev) => (
                          <li key={ev.id} className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLES[ev.event_type] || 'bg-slate-100 text-slate-500'}`}>{ev.event_type}</span>
                            <span className="font-mono text-slate-500">{new Date(ev.fired_at).toLocaleString()}</span>
                            {ev.message && <span className="text-slate-500 truncate">{ev.message}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
