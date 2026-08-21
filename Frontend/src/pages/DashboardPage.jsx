import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart3, Loader2, AlertCircle, CheckCircle2, XCircle, RefreshCw,
  ChevronDown, Layers, Database, ShieldAlert, Download, FileText, FileSpreadsheet,
  Presentation, PlugZap,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { fetchS2DMappings, fetchS2DAnalytics, exportS2DAnalytics } from '../api';
import { captureCharts } from '../chartCapture';
import { ListFilter } from '../components/common/ListFilter';
import { filterByName, noMatchNote } from '../listFilter';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

/**
 * Status colours are reserved: they mean pass/error/fail everywhere and are
 * never reused as "series 4". Every status is also carried by an icon or a text
 * label, so the meaning never rests on colour alone.
 *
 * Checked with the palette validator rather than by eye - the first pair tried
 * (the brand's own green and amber) failed protanopia separation at dE 5.9, and
 * amber-700 against red-600 failed even normal vision at dE 9.9. These pass all
 * six checks on a white surface.
 */
const STATUS_COLOR = { PASS: '#001499', ERROR: '#CA8A04', FAIL: '#DC2626' };

/**
 * Categorical hues for test layers, assigned in FIXED order and never cycled -
 * a layer keeps its colour when the selection changes, so filtering can't
 * repaint the survivors. Validated as a set; the two lighter hues carry a
 * legend and direct labels, which is the relief their contrast warning needs.
 */
const LAYER_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const layerColor = (index) => LAYER_COLORS[index % LAYER_COLORS.length];

// Kept in step with ANALYTICS_RANGES in app.py.
// A .pbix is not here on purpose: the format is proprietary with no authoring
// API, so the honest Power BI answer is a dataset plus a connection file.
const EXPORT_FORMATS = [
  ['pdf', 'PDF report', FileText, 'Charts and tables, ready to send'],
  ['docx', 'Word document', FileText, 'Editable write-up with the same figures'],
  ['pptx', 'PowerPoint deck', Presentation, 'One chart per slide, for a walkthrough'],
  ['xlsx', 'Power BI dataset (Excel)', FileSpreadsheet, 'One row per check - import and build visuals'],
  ['pbids', 'Power BI connection file', PlugZap, 'Opens Power BI against the live data'],
];

const RANGES = [
  ['1m', 'Last month'], ['3m', '3 months'], ['6m', '6 months'], ['1y', '1 year'], ['all', 'All time'],
];

const AXIS = { stroke: '#94a3b8', fontSize: 11 };
const GRID = { stroke: '#e2e8f0', strokeDasharray: '3 3' };

const nf = (n) => (n ?? 0).toLocaleString();

// Column config for "Where the violations are" - one place naming which
// fields are sortable and how to compare them, so the header row and the
// sort logic can't drift apart.
const OFFENDER_COLUMNS = [
  { key: 'test_name', label: 'Check', type: 'string' },
  { key: 'mapping_name', label: 'Test layer', type: 'string' },
  { key: 'validation_type', label: 'Dimension', type: 'string' },
  { key: 'violations', label: 'Violations', type: 'number', align: 'right' },
  { key: 'total_rows', label: 'Rows', type: 'number', align: 'right' },
  { key: 'status', label: 'Status', type: 'string' },
];

function sortOffenders(rows, { key, dir }) {
  const col = OFFENDER_COLUMNS.find((c) => c.key === key);
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (col?.type === 'number') {
      // Nulls (e.g. total_rows on a comparison check) sort last regardless of
      // direction - "unknown" isn't meaningfully high or low.
      const av = a[key], bv = b[key];
      if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
      if (bv === null || bv === undefined) return -1;
      return (av - bv) * sign;
    }
    return String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * sign;
  });
}
const pct = (n) => (n === null || n === undefined ? '--' : `${n}%`);

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString();
}

/** Chart shell: title, optional subtitle, and a real empty state instead of bare axes. */
function Panel({ title, hint, isEmpty, emptyNote, children, className = '' }) {
  return (
    // min-w-0 is load-bearing: a grid/flex child defaults to min-width:auto and
    // refuses to shrink below its content, which let a chart measured at desktop
    // width stay 927px inside a 513px column and push the page sideways.
    // overflow-x-auto is the belt to that braces - anything still too wide
    // scrolls inside its own card rather than scrolling the whole page.
    <div
      data-chart-title={title}
      className={`bg-white border border-slate-200 rounded-xl shadow-sm p-4 min-w-0 ${className}`}
    >
      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">{title}</h4>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
      <div className="mt-3 min-w-0 overflow-x-auto">
        {isEmpty
          ? <p className="text-sm text-slate-400 italic py-8 text-center">{emptyNote}</p>
          : children}
      </div>
    </div>
  );
}

/**
 * A headline number. Deliberately not a chart: one value with no comparison is
 * read faster as text, and the skill's form heuristic says so.
 */
function Kpi({ label, value, sub, tone = 'default', icon: Icon }) {
  const tones = {
    default: 'text-slate-800',
    good: 'text-[#047857]',
    bad: 'text-[#DC2626]',
    warn: 'text-[#CA8A04]',
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
        {Icon && <Icon className="w-3.5 h-3.5" />} {label}
      </p>
      <p className={`text-2xl font-bold mt-1 ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

/** Checkbox dropdown - a native multi-select is unusable for this. */
function LayerPicker({ layers, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const label = selected.length === 0
    ? 'All test layers'
    : selected.length === 1
      ? layers.find((l) => l.id === selected[0])?.name || '1 test layer'
      : `${selected.length} test layers`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white hover:bg-slate-50 min-w-56 justify-between"
      >
        <span className="flex items-center gap-2 truncate">
          <Layers className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-72 max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg p-1">
          <button
            onClick={() => onChange([])}
            className={`w-full text-left px-2 py-1.5 text-sm rounded hover:bg-slate-50 ${
              selected.length === 0 ? 'text-mastek-primary font-medium' : 'text-slate-600'
            }`}
          >
            All test layers
          </button>
          <div className="border-t border-slate-100 my-1" />
          {layers.map((l, i) => (
            <label
              key={l.id}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-slate-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(l.id)}
                onChange={() => onChange(
                  selected.includes(l.id)
                    ? selected.filter((id) => id !== l.id)
                    : [...selected, l.id],
                )}
                className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent"
              />
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: layerColor(i) }}
              />
              <span className="truncate text-slate-700">{l.name}</span>
            </label>
          ))}
          {layers.length === 0 && (
            <p className="px-2 py-2 text-xs text-slate-400 italic">No test layers yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [layers, setLayers] = useState([]);
  const [selected, setSelected] = useState([]);
  const [basis, setBasis] = useState('latest');
  const [range, setRange] = useState('all');
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Action-driven loading, like PipelinesPage: this repo lints against setState
  // in an effect body, and a stale response must never overwrite a newer one.
  const requestRef = useRef(0);

  const load = useCallback(async (mappingIds, nextBasis, nextRange) => {
    const seq = ++requestRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchS2DAnalytics({ mappingIds, basis: nextBasis, range: nextRange });
      if (seq === requestRef.current) { setData(result); setIsLoading(false); }
    } catch (err) {
      if (seq === requestRef.current) { setError(err.message); setIsLoading(false); }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchS2DMappings()
      .then((rows) => { if (!cancelled) setLayers(rows || []); })
      .catch(() => { /* the dashboard still works without the picker */ });
    // Deferred to a microtask: calling load() straight from the effect body
    // would run its setIsLoading synchronously during the effect, which is
    // exactly the cascading-render pattern this repo lints against. isLoading
    // already starts true, so nothing flickers.
    Promise.resolve().then(() => load([], 'latest', 'all'));
    return () => { cancelled = true; };
  }, [load]);

  const applySelection = (next) => { setSelected(next); load(next, basis, range); };
  const applyBasis = (next) => { setBasis(next); load(selected, next, range); };
  const applyRange = (next) => { setRange(next); load(selected, basis, next); };

  const [exporting, setExporting] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState(null);

  // "Where the violations are" search + sort. Default matches the list's
  // long-standing behavior (most violations first) so nobody sees a different
  // order just from this feature landing.
  const [offenderQuery, setOffenderQuery] = useState('');
  const [offenderSort, setOffenderSort] = useState({ key: 'violations', dir: 'desc' });

  const runExport = async (format) => {
    setExporting(format);
    setExportError(null);
    setExportOpen(false);
    try {
      // The workbook and the connection file carry no pictures, so don't pay
      // the capture cost for them.
      const charts = ['pdf', 'docx', 'pptx'].includes(format) ? await captureCharts() : [];
      const { blob, filename } = await exportS2DAnalytics({
        format,
        mapping_ids: selected.join(','),
        basis,
        range,
        scope_layers: selected.map((id) => layers.find((l) => l.id === id)?.name).filter(Boolean),
        charts,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(null);
    }
  };

  const summary = data?.summary;
  const checks = summary?.checks;
  const statusData = checks ? [
    { name: 'Passed', key: 'PASS', value: checks.pass },
    { name: 'Failed', key: 'FAIL', value: checks.fail },
    { name: 'Errored', key: 'ERROR', value: checks.error },
  ].filter((d) => d.value > 0) : [];

  const byType = data?.by_validation_type || [];
  const byLayer = data?.by_layer || [];
  const offenders = data?.worst_offenders || [];
  // Server sends up to OFFENDER_CAP (200), most-violations-first, stating the
  // true total in offender_count - so a search here can find a specific test
  // case even when it's nowhere near the top, and a truncation (if the real
  // count ever exceeds the cap) is visible rather than silent.
  const offenderTotal = data?.offender_count ?? offenders.length;

  /**
   * One line per layer reads well for a handful; this workspace has 32 layers
   * once deleted ones are counted, and 32 lines is a scribble. Past the cap the
   * chart switches to a single pooled series - checks passed over checks run,
   * per day - which is the only honest way to draw "overall" without implying
   * each layer weighs the same.
   */
  const TREND_SERIES_CAP = 6;
  const trendRows = data?.trend || [];
  const trendLayerNames = [...new Set(trendRows.map((t) => t.mapping_name))];
  const poolTrend = trendLayerNames.length > TREND_SERIES_CAP;

  const trendByDate = {};
  trendRows.forEach((t) => {
    const key = shortDate(t.started_at);
    const bucket = trendByDate[key] || { date: key, _pass: 0, _total: 0 };
    if (poolTrend) {
      bucket._pass += t.pass_count || 0;
      bucket._total += t.total_checkpoints || 0;
    } else {
      bucket[t.mapping_name] = t.pass_pct;
    }
    trendByDate[key] = bucket;
  });
  const trendData = Object.values(trendByDate).map((b) => (poolTrend
    ? { date: b.date, 'All layers': b._total ? Math.round(b._pass / b._total * 100) : null }
    : b));
  const trendLayers = poolTrend ? ['All layers'] : trendLayerNames;

  // Same reasoning for the comparison bars: 32 rows is a wall, not a chart.
  const LAYER_BAR_CAP = 8;
  const layerBars = [...byLayer]
    .sort((a, b) => (b.pass + b.fail + b.error) - (a.pass + a.fail + a.error))
    .slice(0, LAYER_BAR_CAP);
  const layersHidden = byLayer.length - layerBars.length;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-800 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-mastek-primary" /> Data Quality Dashboard
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            What the recorded test results say about your data &mdash; how much of it is clean,
            which checks are failing, and whether it is improving.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <LayerPicker layers={layers} selected={selected} onChange={applySelection} />

          <div className="flex rounded-lg border border-slate-300 overflow-hidden">
            {RANGES.map(([value, text]) => (
              <button
                key={value}
                onClick={() => applyRange(value)}
                title={value === 'all' ? 'Every run ever recorded' : `Runs started in the last ${text.toLowerCase()}`}
                className={`px-2.5 py-1.5 text-xs ${
                  range === value ? 'bg-mastek-primary text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {text}
              </button>
            ))}
          </div>
          {/* Latest describes the data as it is now; All is the honest view when
              a layer has only been run once or twice. */}
          <div className="flex rounded-lg border border-slate-300 overflow-hidden">
            {[['latest', 'Latest run'], ['all', 'All runs']].map(([value, text]) => (
              <button
                key={value}
                onClick={() => applyBasis(value)}
                className={`px-3 py-1.5 text-sm ${
                  basis === value ? 'bg-mastek-primary text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {text}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(selected, basis, range)}
            title="Reload"
            className="p-2 text-slate-500 border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          <div className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              disabled={!!exporting || !summary || (summary.checks?.total ?? 0) === 0}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50"
            >
              {exporting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />}
              {exporting ? 'Preparing...' : 'Download'}
            </button>

            {exportOpen && (
              <div className="absolute right-0 z-20 mt-1 w-80 bg-white border border-slate-200 rounded-lg shadow-lg p-1">
                {EXPORT_FORMATS.map(([value, label, Icon, hint]) => (
                  <button
                    key={value}
                    onClick={() => runExport(value)}
                    className="w-full flex items-start gap-2.5 px-2.5 py-2 text-left rounded hover:bg-slate-50"
                  >
                    <Icon className="w-4 h-4 text-mastek-primary shrink-0 mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-sm text-slate-700">{label}</span>
                      <span className="block text-[11px] text-slate-400">{hint}</span>
                    </span>
                  </button>
                ))}
                <p className="px-2.5 py-2 text-[11px] text-slate-400 border-t border-slate-100">
                  Exports cover exactly what is on screen &mdash; the same layers, window and charts.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {selected.length === 0 && (
        <p className="flex items-start gap-2 text-sm text-mastek-primary bg-mastek-primary/5 border border-mastek-primary/20 rounded-lg px-3 py-2">
          <Layers className="w-4 h-4 shrink-0 mt-0.5" />
          Showing every test case that has been run. <strong>Select a test layer above to see its
          analytics</strong> &mdash; you can pick more than one to compare them.
        </p>
      )}

      {(error || exportError) && (
        <p className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {error || exportError}
        </p>
      )}

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading results...
        </p>
      )}

      {!isLoading && summary && checks.total === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-10 text-center">
          <BarChart3 className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500">
            {selected.length > 0
              ? 'No results for the selected test layer(s) yet. Run their test cases and the analytics will appear here.'
              : 'No test results recorded yet. Run a test layer to populate this dashboard.'}
          </p>
          {basis === 'latest' && (
            <p className="text-xs text-slate-400 mt-2">
              Showing the latest run only &mdash; try <strong>All runs</strong> for the full history.
            </p>
          )}
        </div>
      )}

      {!isLoading && summary && checks.total > 0 && (
        <>
          {/* Two separate headline numbers: checks passing and rows clean answer
              different questions, and one hides the other if merged. */}
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Checks passed" icon={CheckCircle2} tone="good"
              value={`${checks.pass} / ${checks.total}`}
              sub={`${checks.total ? Math.round(checks.pass / checks.total * 100) : 0}% of checks run`}
            />
            <Kpi
              label="Checks failed" icon={XCircle} tone={checks.fail > 0 ? 'bad' : 'default'}
              value={nf(checks.fail)}
              sub={checks.error > 0 ? `${checks.error} errored (couldn't run)` : 'none errored'}
            />
            <Kpi
              label="Row-level quality" icon={Database}
              tone={summary.rows.quality_pct === null ? 'default'
                : summary.rows.quality_pct >= 99 ? 'good' : summary.rows.quality_pct >= 90 ? 'warn' : 'bad'}
              value={pct(summary.rows.quality_pct)}
              sub={`${nf(summary.rows.clean)} clean of ${nf(summary.rows.examined)} rows examined`}
            />
            <Kpi
              label="Null values found" icon={ShieldAlert}
              tone={summary.nulls.violations > 0 ? 'warn' : 'good'}
              value={nf(summary.nulls.violations)}
              sub={`across ${summary.nulls.checks} null check${summary.nulls.checks === 1 ? '' : 's'}`}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel
              title="Check outcomes"
              hint={`${summary.runs_covered} run${summary.runs_covered === 1 ? '' : 's'} across ${summary.layers_covered} test layer${summary.layers_covered === 1 ? '' : 's'}`}
              isEmpty={statusData.length === 0}
              emptyNote="No checks in scope."
            >
              {/* Taller container and a smaller ring: at 92px the slice labels
                  sat on top of the legend underneath them. */}
              <ResponsiveContainer width="100%" height={280}>
                <PieChart margin={{ top: 4, bottom: 24 }}>
                  <Pie
                    data={statusData} dataKey="value" nameKey="name"
                    cy="45%"
                    innerRadius={48} outerRadius={76} paddingAngle={2} stroke="#ffffff" strokeWidth={2}
                    label={({ name, value }) => `${name}: ${value}`}
                    labelLine={false}
                  >
                    {statusData.map((d) => <Cell key={d.key} fill={STATUS_COLOR[d.key]} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [`${nf(v)} checks`, n]} />
                  <Legend verticalAlign="bottom" height={28} wrapperStyle={{ paddingTop: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </Panel>

            <Panel
              title="Outcome by quality dimension"
              hint="Which kind of check is failing - the most actionable view on this page"
              isEmpty={byType.length === 0}
              emptyNote="No checks in scope."
            >
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byType} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid {...GRID} horizontal={false} />
                  <XAxis type="number" {...AXIS} allowDecimals={false} />
                  <YAxis type="category" dataKey="type" width={140} {...AXIS} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="pass" name="Passed" stackId="s" fill={STATUS_COLOR.PASS} />
                  <Bar dataKey="fail" name="Failed" stackId="s" fill={STATUS_COLOR.FAIL} />
                  <Bar dataKey="error" name="Errored" stackId="s" fill={STATUS_COLOR.ERROR} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            <Panel
              title="Violation rate by dimension"
              hint="Violating rows as a share of rows examined - normalised, so one huge check can't flatten the rest"
              isEmpty={byType.every((t) => t.violation_pct === null)}
              emptyNote="No check in scope reported row counts."
            >
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={byType.filter((t) => t.violation_pct !== null)}
                  margin={{ left: 8, right: 16, bottom: 28 }}
                >
                  <CartesianGrid {...GRID} vertical={false} />
                  <XAxis dataKey="type" {...AXIS} angle={-18} textAnchor="end" height={48} interval={0} />
                  <YAxis {...AXIS} unit="%" />
                  <Tooltip formatter={(v) => `${v}% of rows`} />
                  <Bar dataKey="violation_pct" name="Violating rows" fill="#2a78d6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            <Panel
              title="Pass rate over time"
              hint={poolTrend
                ? `Checks passed over checks run, per day, pooled across ${trendLayerNames.length} test layers - too many to draw separately`
                : "Full run history for the layers in scope - a trend over one run isn't a trend"}
              isEmpty={trendData.length < 2}
              emptyNote="Needs at least two runs to show a trend."
            >
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={trendData} margin={{ left: 8, right: 16 }}>
                  <CartesianGrid {...GRID} vertical={false} />
                  <XAxis dataKey="date" {...AXIS} />
                  <YAxis {...AXIS} unit="%" domain={[0, 100]} />
                  <Tooltip formatter={(v, n) => [`${v}% passed`, n]} />
                  {trendLayers.length > 1 && <Legend />}
                  {trendLayers.map((name, i) => (
                    <Line
                      key={name} type="monotone" dataKey={name} name={name}
                      stroke={layerColor(i)} strokeWidth={2} dot={{ r: 4 }} connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </Panel>
          </div>

          {layerBars.length > 1 && (
            <Panel
              title="Test layers compared"
              hint={layersHidden > 0
                ? `Checks by outcome for the ${layerBars.length} busiest layers - ${layersHidden} quieter layer${layersHidden === 1 ? '' : 's'} not shown. Select layers above to compare specific ones.`
                : 'Checks by outcome, per layer'}
              isEmpty={false}
            >
              <ResponsiveContainer width="100%" height={Math.max(200, layerBars.length * 42)}>
                <BarChart data={layerBars} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid {...GRID} horizontal={false} />
                  <XAxis type="number" {...AXIS} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={180} {...AXIS} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="pass" name="Passed" fill={STATUS_COLOR.PASS} radius={[0, 4, 4, 0]} />
                  <Bar dataKey="fail" name="Failed" fill={STATUS_COLOR.FAIL} radius={[0, 4, 4, 0]} />
                  <Bar dataKey="error" name="Errored" fill={STATUS_COLOR.ERROR} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          )}

          <Panel
            title="Where the violations are"
            hint={`The checks that found the most violating rows. Counts are exactly what the check reported - a cross-table check can legitimately report more violations than the table has rows.${
              offenderTotal > offenders.length ? ` Showing top ${offenders.length} of ${offenderTotal}.` : ''
            }`}
            isEmpty={offenders.length === 0}
            emptyNote="No check in scope reported any violations."
          >
            {offenders.length > 0 && (
              <ListFilter
                value={offenderQuery} onChange={setOffenderQuery}
                total={offenders.length} shown={filterByName(offenders, offenderQuery, (o) => o.test_name).length}
                placeholder="Search by check name..."
                className="mb-2"
              />
            )}
            {/* Outer wrapper handles horizontal overflow; inner wrapper caps
                height so a long violations list doesn't stretch the page.
                thead uses sticky top-0 so it stays visible while scrolling. */}
            <div className="overflow-x-auto">
              <div className="overflow-y-auto max-h-72">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white text-left text-xs font-medium text-slate-400 border-b border-slate-100 z-10">
                    <tr>
                      {OFFENDER_COLUMNS.map((col) => {
                        const active = offenderSort.key === col.key;
                        const Icon = active ? (offenderSort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                        return (
                          <th
                            key={col.key}
                            className={`px-2 py-2 ${col.align === 'right' ? 'text-right' : ''}`}
                          >
                            <button
                              type="button"
                              onClick={() => setOffenderSort((prev) => ({
                                key: col.key,
                                dir: prev.key === col.key && prev.dir === 'desc' ? 'asc' : 'desc',
                              }))}
                              className={`inline-flex items-center gap-1 hover:text-slate-600 ${
                                col.align === 'right' ? 'flex-row-reverse' : ''
                              } ${active ? 'text-slate-600' : ''}`}
                              title={`Sort by ${col.label}`}
                            >
                              {col.label}
                              <Icon className={`w-3 h-3 ${active ? 'text-mastek-primary' : 'text-slate-300'}`} />
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(() => {
                      const visible = sortOffenders(filterByName(offenders, offenderQuery, (o) => o.test_name), offenderSort);
                      if (visible.length === 0) {
                        return (
                          <tr><td colSpan={OFFENDER_COLUMNS.length} className="px-2 py-4 text-sm text-slate-400 italic text-center">
                            {noMatchNote(offenderQuery)}
                          </td></tr>
                        );
                      }
                      return visible.map((o, i) => (
                      <tr key={`${o.run_id}-${o.test_name}-${i}`}>
                        <td className="px-2 py-2 text-slate-700 truncate max-w-[220px]" title={o.rule_target}>
                          {o.test_name}
                        </td>
                        <td className="px-2 py-2 text-slate-500 truncate max-w-[160px]">{o.mapping_name}</td>
                        <td className="px-2 py-2 text-slate-500">{o.validation_type}</td>
                        <td className="px-2 py-2 text-right font-medium text-slate-700">{nf(o.violations)}</td>
                        <td className="px-2 py-2 text-right text-slate-500">
                          {o.total_rows === null ? '--' : nf(o.total_rows)}
                        </td>
                        <td className="px-2 py-2">
                          <span
                            className="text-xs font-medium px-1.5 py-0.5 rounded"
                            style={{ color: STATUS_COLOR[o.status], backgroundColor: `${STATUS_COLOR[o.status]}14` }}
                          >
                            {o.status}
                          </span>
                        </td>
                      </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          </Panel>

          <p className="text-[11px] text-slate-400">
            {summary.rows.excluded_results > 0 && (
              <>
                {summary.rows.excluded_results} check{summary.rows.excluded_results === 1 ? '' : 's'} report
                no row counts (comparisons, freshness, categorical) and are excluded from row-level
                quality rather than counted as zero.{' '}
              </>
            )}
            {summary.orphaned_runs > 0 && (
              summary.orphaned_runs_included
                ? <>Includes {summary.orphaned_runs} run{summary.orphaned_runs === 1 ? '' : 's'} whose
                  test layer has since been deleted, shown as &ldquo;(deleted test layer)&rdquo;.</>
                : <>{summary.orphaned_runs} run{summary.orphaned_runs === 1 ? '' : 's'} from deleted
                  test layers are excluded while a layer filter is applied.</>
            )}
          </p>
        </>
      )}
    </div>
  );
}
