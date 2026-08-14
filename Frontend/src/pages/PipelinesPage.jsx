import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PlayCircle, Loader2, AlertCircle, CheckCircle2, XCircle, RefreshCw,
  ArrowRight, Workflow, CalendarClock,
} from 'lucide-react';
import {
  fetchConnectors, fetchConnectorContainers, fetchContainerTables,
  fetchPipelines, runPipeline, fetchPipelineRun, fetchPipelineRuns,
  fetchPipelineSchedules, createPipelineSchedule, updatePipelineSchedule,
  deletePipelineSchedule, fetchPipelineScheduleEvents,
} from '../api';
import SchedulesSection from '../components/schedules/SchedulesSection';

// Fabric reports NotStarted/InProgress while a job is live; everything else
// (Completed, Failed, Cancelled, Deduped) is terminal. The backend already
// flattens that into is_running - see _pipeline_run_to_dict.
const POLL_MS = 5000;
// A pipeline that hasn't finished in this long probably needs looking at in
// Fabric itself, so stop polling and offer a manual refresh rather than
// hammering the API indefinitely.
const MAX_POLL_MS = 15 * 60 * 1000;

const STATUS_STYLES = {
  Completed: 'bg-mastek-success/10 text-mastek-success border-mastek-success/30',
  Failed: 'bg-red-50 text-red-600 border-red-200',
  Cancelled: 'bg-amber-50 text-amber-700 border-amber-200',
  Deduped: 'bg-slate-100 text-slate-500 border-slate-200',
};

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || 'bg-mastek-accent/10 text-mastek-primary border-mastek-accent/30';
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${style}`}>
      {status || 'Unknown'}
    </span>
  );
}

function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * "2m 14s" between two timestamps. Fabric stamps these without a timezone
 * suffix (e.g. "2026-08-14T05:13:35.3166667"), which JS would read as LOCAL
 * time - so a Z is appended when one is missing, otherwise the duration is off
 * by the browser's UTC offset and can even come out negative.
 */
function parseUtc(iso) {
  if (!iso) return null;
  const normalized = /[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function formatDuration(fromIso, toIso) {
  const start = parseUtc(fromIso);
  const end = toIso ? parseUtc(toIso) : Date.now();
  if (start === null || end === null) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * What actually changed in the watched Lakehouse, by comparing table row counts
 * taken before the run with the same taken after.
 *
 * Fabric exposes no per-activity detail - the activity-run endpoints don't
 * exist - so measuring the effect is the only way to report which tables a run
 * touched, and it works for every pipeline shape including the ones whose table
 * list is decided at runtime.
 *
 * Returns only rows that MOVED. A rewrite that lands the same number of rows is
 * invisible to this, which the UI says out loud rather than implying nothing
 * happened.
 */
function diffSnapshots(before, after) {
  if (!before || !after) return [];
  const changes = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    const from = before[name];
    const to = after[name];
    if (from === to) continue;
    changes.push({
      name,
      from: from ?? null,
      to: to ?? null,
      added: from === undefined,
      removed: to === undefined,
      delta: (to ?? 0) - (from ?? 0),
    });
  }
  return changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** Table name -> row count, from the tables endpoint's payload. */
function snapshotOf(tables) {
  return Object.fromEntries((tables || []).map((t) => [t.name, t.row_count]));
}

export default function PipelinesPage({ onGoToHarvest }) {
  const [connectors, setConnectors] = useState([]);
  const [connectorId, setConnectorId] = useState('');
  const [pipelines, setPipelines] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const [startingId, setStartingId] = useState(null);
  const [runError, setRunError] = useState(null);
  // { pipelineId, pipelineName, runId, status, is_running, started_at, finished_at, failure_reason }
  const [activeRun, setActiveRun] = useState(null);
  const [pollExpired, setPollExpired] = useState(false);
  const [history, setHistory] = useState([]);

  // Which Lakehouse to measure for changes. The framework can't know which one
  // a given pipeline writes to - Fabric doesn't say - so the tester picks.
  const [containers, setContainers] = useState([]);
  const [watchContainerId, setWatchContainerId] = useState('');
  // { before, after, status } - snapshots are table name -> row count.
  const [tableDiff, setTableDiff] = useState(null);
  // Which pipeline's schedules are open, so SchedulesSection knows its parent.
  const [schedulingFor, setSchedulingFor] = useState(null);

  // Which connector's pipelines we most recently asked for. Loading is driven by
  // actions (page load, changing the dropdown) rather than by an effect watching
  // connectorId, so nothing sets state synchronously during render. This ref is
  // what a useEffect cleanup would otherwise give us: a way to drop a slow
  // response for a connector the tester has already switched away from.
  const requestedConnectorRef = useRef('');

  const loadPipelines = (id) => {
    requestedConnectorRef.current = id;
    if (!id) {
      setPipelines([]);
      setContainers([]);
      return;
    }
    setIsLoading(true);
    setLoadError(null);
    fetchPipelines(id)
      .then((data) => {
        if (requestedConnectorRef.current !== id) return;
        setPipelines(data.pipelines || []);
        setIsLoading(false);
      })
      .catch((err) => {
        if (requestedConnectorRef.current !== id) return;
        setLoadError(err.message);
        setPipelines([]);
        setIsLoading(false);
      });
    // Lakehouses to offer as the "watch for changes" target.
    fetchConnectorContainers(id)
      .then((data) => {
        if (requestedConnectorRef.current !== id) return;
        const list = data.containers || [];
        setContainers(list);
        setWatchContainerId((cur) => cur || (list[0]?.id ?? ''));
      })
      .catch(() => { if (requestedConnectorRef.current === id) setContainers([]); });
  };

  /** Row counts for every table in the watched Lakehouse, or null if unavailable. */
  const snapshotWatched = useCallback(async () => {
    if (!watchContainerId) return null;
    try {
      const data = await fetchContainerTables(connectorId, watchContainerId, { includeRowCounts: true });
      return snapshotOf(data.tables);
    } catch {
      return null;  // never let a failed snapshot block the run itself
    }
  }, [connectorId, watchContainerId]);

  useEffect(() => {
    let cancelled = false;
    fetchConnectors()
      .then((data) => {
        if (cancelled) return;
        // Pipelines are a Fabric concept - a Local connector has none.
        const fabric = (data.connectors || data || []).filter((c) => c.type === 'fabric');
        setConnectors(fabric);
        const first = fabric[0]?.id ?? '';
        if (first) {
          setConnectorId(first);
          loadPipelines(first);
        }
      })
      .catch((err) => { if (!cancelled) setLoadError(err.message); });
    return () => { cancelled = true; };
  }, []);

  const loadHistory = useCallback((pipelineId) => {
    fetchPipelineRuns(connectorId, pipelineId)
      .then((data) => setHistory(data.runs || []))
      .catch(() => setHistory([]));
  }, [connectorId]);

  // Pulled out as primitives so the polling effect below depends on the three
  // values it actually uses rather than the whole activeRun object - otherwise
  // every unrelated field change would tear down and restart the interval.
  const runId = activeRun?.runId;
  const pipelineId = activeRun?.pipelineId;
  const runIsLive = activeRun?.is_running ?? false;

  // Poll the live run until Fabric reports it finished. setState only happens
  // inside callbacks, never synchronously in the effect body - this repo lints
  // against the latter.
  useEffect(() => {
    if (!runId || !runIsLive) return undefined;
    let cancelled = false;
    let timer;
    const startedPollingAt = Date.now();

    const poll = () => {
      if (Date.now() - startedPollingAt > MAX_POLL_MS) {
        clearInterval(timer);
        if (!cancelled) setPollExpired(true);
        return;
      }
      fetchPipelineRun(connectorId, pipelineId, runId)
        .then((r) => {
          if (cancelled) return;
          // Keep our own runId: it's the one we're polling, and the payload's
          // id field isn't guaranteed to come back populated.
          setActiveRun((prev) => (prev && prev.runId === runId ? { ...prev, ...r, runId } : prev));
          // Refresh history the moment it finishes, so the table below shows the
          // run that just completed. Done here rather than in another effect
          // watching is_running - a callback is exactly where this belongs.
          if (!r.is_running) {
            loadHistory(pipelineId);
            // Take the "after" reading now that the pipeline has stopped
            // writing, and diff it against the one taken before it started.
            setTableDiff((prev) => (prev && prev.before ? { ...prev, status: 'measuring' } : prev));
            snapshotWatched().then((after) => {
              if (cancelled) return;
              setTableDiff((prev) => (prev && prev.before
                ? { ...prev, after, status: after ? 'done' : 'failed' }
                : prev));
            });
          }
        })
        .catch(() => { /* transient - the next tick will try again */ });
    };

    timer = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [runId, runIsLive, pipelineId, connectorId, loadHistory, snapshotWatched]);

  const handleRun = async (pipeline) => {
    setStartingId(pipeline.id);
    setRunError(null);
    setPollExpired(false);
    setTableDiff(watchContainerId ? { before: null, after: null, status: 'measuring' } : null);
    try {
      // Read the "before" counts and start the pipeline together. Waiting for
      // the snapshot first would delay the run by ~10s on Fabric; the pipeline
      // takes far longer to touch anything than the snapshot takes to finish.
      const [{ run_id }, before] = await Promise.all([
        runPipeline(connectorId, pipeline.id),
        snapshotWatched(),
      ]);
      setTableDiff(before ? { before, after: null, status: 'waiting' } : null);
      setActiveRun({
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        runId: run_id,
        status: 'NotStarted',
        is_running: true,
      });
      loadHistory(pipeline.id);
    } catch (err) {
      setRunError(err.message);
      setTableDiff(null);
    } finally {
      setStartingId(null);
    }
  };

  const refreshActiveRun = () => {
    if (!activeRun) return;
    setPollExpired(false);
    fetchPipelineRun(connectorId, activeRun.pipelineId, activeRun.runId)
      .then((r) => setActiveRun((prev) => (prev ? { ...prev, ...r, runId: prev.runId } : prev)))
      .catch((err) => setRunError(err.message));
  };

  const succeeded = activeRun && !activeRun.is_running && activeRun.status === 'Completed';
  const failed = activeRun && !activeRun.is_running && activeRun.status !== 'Completed';

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-800 flex items-center gap-2">
          <Workflow className="w-5 h-5 text-mastek-primary" /> Data Pipelines
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          Run a Fabric pipeline to load data, wait for it to finish, then head to Harvest to pick up
          the Lakehouse it populated.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-3">
        <label className="flex items-center gap-3 max-w-xl">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0">
            Connector
          </span>
          <select
            value={connectorId}
            onChange={(e) => {
              setConnectorId(e.target.value);
              setActiveRun(null);
              setHistory([]);
              loadPipelines(e.target.value);
            }}
            className="flex-1 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
          >
            {connectors.length === 0 && <option value="">No Fabric connector yet — add one on Connect</option>}
            {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>

        {containers.length > 0 && (
          <label className="flex items-center gap-3 max-w-xl">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0">
              Watch
            </span>
            <select
              value={watchContainerId}
              onChange={(e) => { setWatchContainerId(e.target.value); setTableDiff(null); }}
              className="flex-1 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
            >
              <option value="">Don&rsquo;t measure table changes</option>
              {containers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        {watchContainerId && (
          <p className="text-xs text-slate-400">
            Row counts are read from this Lakehouse just before and just after the run, and the
            difference is shown below. Fabric doesn&rsquo;t report which tables a pipeline touched, so
            this measures the effect instead &mdash; a rewrite that lands the same number of rows
            won&rsquo;t show up.
          </p>
        )}

        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading pipelines...
          </p>
        )}
        {loadError && (
          <p className="flex items-start gap-2 text-sm text-red-600">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {loadError}
          </p>
        )}
        {!isLoading && !loadError && pipelines.length === 0 && connectorId && (
          <p className="text-sm text-slate-400 italic">No Data Pipelines in this workspace.</p>
        )}

        {pipelines.length > 0 && (
          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
            {pipelines.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700 truncate">{p.name}</p>
                  <p className="text-[11px] text-slate-400 font-mono truncate">{p.id}</p>
                </div>
                <button
                  onClick={() => setSchedulingFor((cur) => (cur?.id === p.id ? null : p))}
                  title="Run this pipeline on a schedule"
                  className={`ml-auto flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border shrink-0 ${
                    schedulingFor?.id === p.id
                      ? 'text-mastek-primary bg-mastek-primary/10 border-mastek-primary/40'
                      : 'text-slate-500 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <CalendarClock className="w-4 h-4" /> Schedule
                </button>
                <button
                  onClick={() => handleRun(p)}
                  disabled={startingId === p.id || (activeRun?.is_running ?? false)}
                  title={activeRun?.is_running ? 'Wait for the running pipeline to finish' : 'Start this pipeline now'}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                >
                  {startingId === p.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <PlayCircle className="w-4 h-4" />}
                  {startingId === p.id ? 'Starting...' : 'Run'}
                </button>
              </div>
            ))}
          </div>
        )}

        {runError && (
          <p className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {runError}
          </p>
        )}
      </div>

      {activeRun && (
        <div className={`bg-white border rounded-xl shadow-sm p-4 space-y-3 ${
          succeeded ? 'border-mastek-success/40' : failed ? 'border-red-200' : 'border-mastek-accent/40'
        }`}>
          <div className="flex items-center gap-2 flex-wrap">
            {activeRun.is_running && <Loader2 className="w-4 h-4 animate-spin text-mastek-primary" />}
            {succeeded && <CheckCircle2 className="w-4 h-4 text-mastek-success" />}
            {failed && <XCircle className="w-4 h-4 text-red-600" />}
            <span className="text-sm font-medium text-slate-800">{activeRun.pipelineName}</span>
            <StatusBadge status={activeRun.status} />
            <button
              onClick={refreshActiveRun}
              title="Check the status now"
              className="ml-auto flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-mastek-primary border border-mastek-primary/40 rounded-md hover:bg-mastek-primary/10"
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>

          <div className="grid grid-cols-2 gap-y-1 text-xs max-w-md">
            <span className="text-slate-400">Run id</span>
            <span className="text-slate-600 font-mono truncate">{activeRun.runId || '--'}</span>
            <span className="text-slate-400">Started</span>
            <span className="text-slate-600">{formatTime(activeRun.started_at)}</span>
            <span className="text-slate-400">Finished</span>
            <span className="text-slate-600">{formatTime(activeRun.finished_at)}</span>
            <span className="text-slate-400">{activeRun.is_running ? 'Running for' : 'Took'}</span>
            {/* While live this re-renders on each 5s poll, so it ticks along. */}
            <span className="text-slate-600 font-medium">
              {formatDuration(activeRun.started_at, activeRun.finished_at) || '--'}
            </span>
          </div>

          {activeRun.failure_reason && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2.5 py-2 whitespace-pre-wrap">
              {activeRun.failure_reason}
            </p>
          )}

          {pollExpired && activeRun.is_running && (
            <p className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Still running after 15 minutes, so automatic checking has stopped. Use Refresh, or look at
              the run in Fabric.
            </p>
          )}

          {succeeded && (
            <div className="flex items-center gap-3 pt-1">
              <p className="text-sm text-mastek-success">
                Pipeline finished. The Lakehouse it loaded is ready to harvest.
              </p>
              <button
                onClick={onGoToHarvest}
                className="ml-auto flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 shrink-0"
              >
                Go to Harvest <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {tableDiff && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-2">
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            Tables changed
          </h4>
          {tableDiff.status !== 'done' && (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              {tableDiff.status === 'failed'
                ? <><AlertCircle className="w-4 h-4 text-amber-600" /> Couldn&rsquo;t read the row counts, so
                   there&rsquo;s nothing to compare. The run itself is unaffected.</>
                : <><Loader2 className="w-4 h-4 animate-spin" />
                   {tableDiff.status === 'waiting'
                     ? 'Counts recorded. Waiting for the run to finish before measuring again...'
                     : 'Reading row counts...'}</>}
            </p>
          )}
          {tableDiff.status === 'done' && (() => {
            const changes = diffSnapshots(tableDiff.before, tableDiff.after);
            if (changes.length === 0) {
              return (
                <p className="text-sm text-slate-500">
                  No table in this Lakehouse changed row count. Either the run wrote nothing here, or
                  it replaced rows without changing how many there are.
                </p>
              );
            }
            return (
              <table className="w-full text-sm">
                <thead className="text-left text-xs font-medium text-slate-400 border-b border-slate-100">
                  <tr>
                    <th className="px-2 py-2">Table</th>
                    <th className="px-2 py-2">Before</th>
                    <th className="px-2 py-2">After</th>
                    <th className="px-2 py-2">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {changes.map((c) => (
                    <tr key={c.name}>
                      <td className="px-2 py-2 font-mono text-xs text-slate-700 truncate">
                        {c.name}
                        {c.added && <span className="ml-2 text-[10px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">new</span>}
                        {c.removed && <span className="ml-2 text-[10px] text-red-600 bg-red-50 px-1.5 py-0.5 rounded">gone</span>}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-500">{c.from === null ? '--' : c.from.toLocaleString()}</td>
                      <td className="px-2 py-2 text-xs text-slate-500">{c.to === null ? '--' : c.to.toLocaleString()}</td>
                      <td className={`px-2 py-2 text-xs font-medium ${c.delta >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {c.delta >= 0 ? '+' : ''}{c.delta.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </div>
      )}

      {history.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
            Recent runs
          </h4>
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-medium text-slate-400 border-b border-slate-100">
              <tr>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Started</th>
                <th className="px-2 py-2">Finished</th>
                <th className="px-2 py-2">Took</th>
                <th className="px-2 py-2">Trigger</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td className="px-2 py-2"><StatusBadge status={r.status} /></td>
                  <td className="px-2 py-2 text-slate-600 text-xs">{formatTime(r.started_at)}</td>
                  <td className="px-2 py-2 text-slate-600 text-xs">{formatTime(r.finished_at)}</td>
                  <td className="px-2 py-2 text-slate-600 text-xs">
                    {formatDuration(r.started_at, r.finished_at) || '--'}
                  </td>
                  <td className="px-2 py-2 text-slate-400 text-xs">{r.invoke_type || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {schedulingFor && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
          <div className="flex items-center gap-2 mb-3">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Schedules for <span className="font-mono text-slate-600 normal-case">{schedulingFor.name}</span>
            </h4>
            <button
              onClick={() => setSchedulingFor(null)}
              className="ml-auto text-xs text-slate-400 hover:text-slate-600"
            >
              Close
            </button>
          </div>
          {/* SchedulesSection takes its whole API surface as callbacks and knows
              nothing about schedule kinds, so it drops straight in. */}
          <SchedulesSection
            parentId={connectorId}
            createExtras={{ pipeline_item_id: schedulingFor.id, pipeline_name: schedulingFor.name }}
            headerHint="Runs this pipeline on a timer. The scheduler waits for each run to finish, so the recorded status is the real outcome."
            fetchList={(cid) => fetchPipelineSchedules(cid, schedulingFor.id).then((d) => d.schedules || [])}
            create={createPipelineSchedule}
            update={updatePipelineSchedule}
            remove={deletePipelineSchedule}
            fetchEvents={fetchPipelineScheduleEvents}
          />
        </div>
      )}
    </div>
  );
}
