import { useEffect, useState } from 'react';
import { Clock, Calendar, ChevronDown, AlertCircle, Loader2 } from 'lucide-react';
import { previewSchedule } from '../../api';

// Cron under the hood for everything. Presets are just canned expressions.
// The preset dropdown says the "browser TZ" label but the actual timezone
// value is filled from Intl.DateTimeFormat.
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const PRESETS = [
  { id: 'every_3h',  label: 'Every 3 hours',            trigger_type: 'cron', trigger_config: { expression: '0 */3 * * *' }, timezone: 'UTC' },
  { id: 'every_6h',  label: 'Every 6 hours',            trigger_type: 'cron', trigger_config: { expression: '0 */6 * * *' }, timezone: 'UTC' },
  { id: 'every_12h', label: 'Every 12 hours',           trigger_type: 'cron', trigger_config: { expression: '0 */12 * * *' }, timezone: 'UTC' },
  { id: 'daily',     label: 'Daily at 00:00 (local)',   trigger_type: 'cron', trigger_config: { expression: '0 0 * * *' }, timezone: null /* filled at render time */ },
  { id: 'weekly',    label: 'Weekly, Mon 00:00 (local)', trigger_type: 'cron', trigger_config: { expression: '0 0 * * 1' }, timezone: null },
  { id: 'twice_wk',  label: 'Twice weekly, Mon+Thu 00:00 (local)', trigger_type: 'cron', trigger_config: { expression: '0 0 * * 1,4' }, timezone: null },
  { id: 'custom',    label: 'Custom…' },
];

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// APScheduler / classic cron day-of-week: Mon=1..Sun=0 OR Mon=1..Sun=7 depending on parser.
// APScheduler's from_crontab accepts 0-6 (Sun=0) OR 1-7 (Mon=1..Sun=7). We use 1..7 with Sun=7 for cleaner UX.
const DAY_CRON_VALUES = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun mapping to cron day-of-week (Sun=0)

function buildCronExpression(daysMask, hour, minute) {
  const days = DAY_LABELS.map((_, i) => daysMask[i] ? DAY_CRON_VALUES[i] : null).filter((d) => d !== null);
  if (days.length === 0) return null;
  return `${minute} ${hour} * * ${days.join(',')}`;
}

function presetToValue(preset) {
  if (preset.id === 'custom') return null;
  return {
    trigger_type: preset.trigger_type,
    trigger_config: preset.trigger_config,
    timezone: preset.timezone || browserTz(),
  };
}

export default function SchedulePicker({ value, onChange }) {
  const [presetId, setPresetId] = useState('every_6h');
  const [customTab, setCustomTab] = useState('interval'); // 'interval' | 'specific'

  // Interval-mode state
  const [intervalN, setIntervalN] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState('minutes'); // 'minutes' | 'hours'

  // Specific-time state
  const [days, setDays] = useState([false, false, false, false, true, false, false]); // default: Fri
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [tz, setTz] = useState(browserTz());

  // Preview state
  const [nextFires, setNextFires] = useState([]);
  const [previewError, setPreviewError] = useState(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  // Compute the current value from picker state
  useEffect(() => {
    let next = null;
    if (presetId !== 'custom') {
      const preset = PRESETS.find((p) => p.id === presetId);
      next = presetToValue(preset);
    } else if (customTab === 'interval') {
      const seconds = intervalUnit === 'hours' ? intervalN * 3600 : intervalN * 60;
      if (seconds >= 60) {
        next = { trigger_type: 'interval', trigger_config: { seconds }, timezone: 'UTC' };
      }
    } else {
      const expression = buildCronExpression(days, hour, minute);
      if (expression) {
        next = { trigger_type: 'cron', trigger_config: { expression }, timezone: tz };
      }
    }
    onChange(next);
  }, [presetId, customTab, intervalN, intervalUnit, days, hour, minute, tz]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preview whenever value changes
  useEffect(() => {
    let cancelled = false;
    if (!value) {
      Promise.resolve().then(() => { if (!cancelled) { setNextFires([]); setPreviewError(null); } });
      return () => { cancelled = true; };
    }
    Promise.resolve().then(() => { if (!cancelled) { setIsPreviewing(true); setPreviewError(null); } });
    previewSchedule(value)
      .then((data) => {
        if (cancelled) return;
        setNextFires(data.next_fires || []);
        setIsPreviewing(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(err.message);
        setNextFires([]);
        setIsPreviewing(false);
      });
    return () => { cancelled = true; };
  }, [value ? JSON.stringify(value) : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDay = (i) => {
    setDays((prev) => prev.map((v, idx) => (idx === i ? !v : v)));
  };
  const setWeekdays = () => setDays([true, true, true, true, true, false, false]);
  const setWeekend = () => setDays([false, false, false, false, false, true, true]);
  const clearDays = () => setDays([false, false, false, false, false, false, false]);

  return (
    <div className="space-y-3">
      {/* Preset dropdown */}
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">Frequency</label>
        <div className="relative">
          <select
            value={presetId}
            onChange={(e) => setPresetId(e.target.value)}
            className="w-full appearance-none pl-3 pr-8 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-mastek-primary/40"
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <ChevronDown className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
      </div>

      {/* Custom card */}
      {presetId === 'custom' && (
        <div className="border border-slate-200 rounded-lg bg-slate-50 p-3">
          <div className="flex gap-1 mb-3">
            <button
              type="button"
              onClick={() => setCustomTab('interval')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md ${
                customTab === 'interval' ? 'bg-white text-slate-800 shadow-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Clock className="w-3.5 h-3.5" /> Interval
            </button>
            <button
              type="button"
              onClick={() => setCustomTab('specific')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md ${
                customTab === 'specific' ? 'bg-white text-slate-800 shadow-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" /> Specific time
            </button>
          </div>

          {customTab === 'interval' && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Every</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={intervalUnit === 'minutes' ? 1 : 1}
                  value={intervalN}
                  onChange={(e) => setIntervalN(Math.max(1, parseInt(e.target.value || '1', 10)))}
                  className="w-24 px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-mastek-primary/40"
                />
                <select
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value)}
                  className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-mastek-primary/40"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
              <p className="text-xs text-slate-400 mt-2">
                Minimum 1 minute. Fires relative to the last run (not wall-clock).
              </p>
            </div>
          )}

          {customTab === 'specific' && (
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-500">Days of week</label>
                  <div className="flex gap-1">
                    <button type="button" onClick={setWeekdays} className="text-xs text-mastek-primary hover:underline">Mon–Fri</button>
                    <span className="text-slate-300">·</span>
                    <button type="button" onClick={setWeekend} className="text-xs text-mastek-primary hover:underline">Sat–Sun</button>
                    <span className="text-slate-300">·</span>
                    <button type="button" onClick={clearDays} className="text-xs text-slate-400 hover:underline">Clear</button>
                  </div>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {DAY_LABELS.map((label, i) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleDay(i)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md border ${
                        days[i]
                          ? 'bg-mastek-primary/10 border-mastek-primary text-mastek-primary'
                          : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Time (24h)</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number" min={0} max={23}
                      value={hour}
                      onChange={(e) => setHour(Math.max(0, Math.min(23, parseInt(e.target.value || '0', 10))))}
                      className="w-16 px-2 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-mastek-primary/40"
                    />
                    <span className="text-slate-500">:</span>
                    <input
                      type="number" min={0} max={59}
                      value={minute}
                      onChange={(e) => setMinute(Math.max(0, Math.min(59, parseInt(e.target.value || '0', 10))))}
                      className="w-16 px-2 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-mastek-primary/40"
                    />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Timezone</label>
                  <input
                    type="text"
                    value={tz}
                    onChange={(e) => setTz(e.target.value)}
                    placeholder="IANA name, e.g. Asia/Kolkata"
                    className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-mastek-primary/40"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Preview */}
      <div className="border border-slate-200 rounded-lg bg-white p-3">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
          Next fires
          {isPreviewing && <Loader2 className="w-3 h-3 animate-spin" />}
        </div>
        {previewError && (
          <div className="flex items-center gap-1.5 text-xs text-red-600">
            <AlertCircle className="w-3.5 h-3.5" /> {previewError}
          </div>
        )}
        {!previewError && nextFires.length === 0 && !isPreviewing && (
          <p className="text-xs text-slate-400">Configure the schedule to preview upcoming runs.</p>
        )}
        {!previewError && nextFires.length > 0 && (
          <ul className="text-xs text-slate-600 space-y-0.5 font-mono">
            {nextFires.slice(0, 5).map((iso, i) => (
              <li key={i}>{new Date(iso).toLocaleString()}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
