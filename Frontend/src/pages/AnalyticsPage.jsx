import { useEffect, useState } from 'react';
import {
  ArrowLeft, CheckCircle2, XCircle, AlertTriangle, Loader2,
  ListChecks, Gauge, History as HistoryIcon, GitCompareArrows,
} from 'lucide-react';
import { fetchS2DRun } from '../api';

const STATUS_BADGE = {
  PASS: 'bg-mastek-success/10 text-mastek-success border border-mastek-success/30',
  FAIL: 'bg-red-50 text-red-600 border border-red-200',
  ERROR: 'bg-mastek-warning/10 text-mastek-warning border border-mastek-warning/30',
};

// A result only has real violations/total_rows for check types that report
// them (row_count_match, column_parity, and any custom SQL that opts in) -
// falls back to a plain pass/fail-derived rate so older/unsupported rows
// still render something sensible instead of blank.
function rowPassRate(r) {
  if (r.total_rows != null && r.total_rows > 0 && r.violations != null) {
    return Math.max(0, Math.min(100, ((r.total_rows - r.violations) / r.total_rows) * 100));
  }
  return r.status === 'PASS' ? 100 : 0;
}

export default function AnalyticsPage({ runId, onBackToS2D, onGoToHistory, onEditTestCase }) {
  const [run, setRun] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedResultId, setSelectedResultId] = useState(null);

  useEffect(() => {
    setIsLoading(true);
    fetchS2DRun(runId)
      .then((data) => {
        setRun(data);
        const firstFailure = data.results.find((r) => r.status !== 'PASS');
        setSelectedResultId(firstFailure ? firstFailure.id : (data.results[0]?.id ?? null));
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  }, [runId]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 p-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading run results...
      </div>
    );
  }

  if (error || !run) {
    return <p className="text-sm text-red-600 p-8">{error || 'Run not found'}</p>;
  }

  const passRate = run.total_checkpoints > 0
    ? ((run.pass_count / run.total_checkpoints) * 100).toFixed(1)
    : '0.0';
  const selectedResult = run.results.find((r) => r.id === selectedResultId);

  return (
    <div className="-m-6 sm:-m-8 flex flex-col h-full">
      <header className="h-14 border-b border-slate-200 bg-white flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => onBackToS2D(run.mapping_id)}
            className="h-7 w-7 rounded bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="font-semibold text-sm tracking-wide text-slate-700">
            ANALYTICS / <span className="text-mastek-primary">RUN {run.id.slice(0, 8)}</span>
          </span>
        </div>
        <span className="text-xs font-mono bg-slate-100 px-2 py-1 rounded text-slate-500">
          EXECUTION COMPLETED
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="bg-white p-1 rounded-lg border border-slate-200 flex flex-wrap gap-1 text-sm font-medium w-fit">
          <button
            onClick={() => onBackToS2D(run.mapping_id)}
            className="px-4 py-1.5 rounded-md flex items-center gap-1.5 text-slate-500 hover:text-slate-700"
          >
            <ListChecks className="w-3.5 h-3.5" /> Rules
          </button>
          <button className="px-4 py-1.5 rounded-md flex items-center gap-1.5 bg-mastek-primary text-white shadow">
            <Gauge className="w-3.5 h-3.5" /> Results
          </button>
          <button
            onClick={onGoToHistory}
            className="px-4 py-1.5 rounded-md flex items-center gap-1.5 text-slate-500 hover:text-slate-700"
          >
            <HistoryIcon className="w-3.5 h-3.5" /> History
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Overall Status</span>
            <div className="flex items-center gap-4">
              <span className="text-xl font-bold text-mastek-success flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> {run.pass_count} Passed
              </span>
              <span className="text-xl font-bold text-red-600 flex items-center gap-1.5">
                <XCircle className="w-4 h-4" /> {run.fail_count} Failed
              </span>
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Total Checkpoints</span>
            <span className="text-3xl font-bold font-mono text-slate-800">{run.total_checkpoints}</span>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Pass Rate</span>
            <span className="text-3xl font-bold font-mono text-mastek-success">{passRate}%</span>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Compute Time</span>
            <span className="text-3xl font-bold font-mono text-mastek-primary">{run.compute_time_seconds}s</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <div className="bg-slate-50 border-b border-slate-200 px-5 py-4">
              <h3 className="font-bold text-sm text-slate-700">Results</h3>
            </div>
            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left whitespace-nowrap">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-400 uppercase tracking-wider font-mono">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Rule</th>
                    <th className="px-3 py-3 font-semibold">Table</th>
                    <th className="px-3 py-3 font-semibold">Result</th>
                    <th className="px-3 py-3 font-semibold">Violations</th>
                    <th className="px-3 py-3 font-semibold">Total Rows</th>
                    <th className="px-3 py-3 font-semibold">Pass Rate</th>
                    <th className="px-3 py-3 font-semibold">Rate</th>
                    <th className="px-3 py-3 font-semibold">Duration</th>
                    <th className="px-3 py-3 font-semibold">Executed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {run.results.map((r) => {
                    const rate = rowPassRate(r);
                    return (
                      <tr
                        key={r.id}
                        onClick={() => setSelectedResultId(r.id)}
                        className={`cursor-pointer hover:bg-slate-50 ${
                          r.id === selectedResultId ? 'bg-slate-50' : ''
                        } ${r.status !== 'PASS' ? 'border-l-2 border-l-red-400' : ''}`}
                      >
                        <td className="px-5 py-3 font-medium text-slate-700">{r.test_name}</td>
                        <td className="px-3 py-3 font-mono text-slate-500">{r.rule_target}</td>
                        <td className="px-3 py-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${STATUS_BADGE[r.status]}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-500">{r.violations ?? '—'}</td>
                        <td className="px-3 py-3 font-mono text-slate-500">{r.total_rows ?? '—'}</td>
                        <td className="px-3 py-3 font-mono text-slate-500">{rate.toFixed(1)}%</td>
                        <td className="px-3 py-3 w-28">
                          <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${rate >= 100 ? 'bg-mastek-success' : rate > 0 ? 'bg-amber-400' : 'bg-red-400'}`}
                              style={{ width: `${rate}%` }}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-400">
                          {r.duration_seconds != null ? `${r.duration_seconds}s` : '—'}
                        </td>
                        <td className="px-3 py-3 text-slate-400">
                          {r.executed_at ? new Date(r.executed_at).toLocaleString() : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm font-mono text-xs flex flex-col h-full min-h-[320px]">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2 text-slate-400">
              {/* The panel now shows passing results too, so a green heading
                  when nothing went wrong - a PASS under a red "ERROR TRACE"
                  banner reads as a failure at a glance. */}
              {selectedResult?.status === 'PASS' ? (
                <span className="font-bold tracking-wide text-mastek-success flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> RESULT DETAIL
                </span>
              ) : (
                <span className="font-bold tracking-wide text-red-600 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> ERROR TRACE ANALYSIS
                </span>
              )}
              <span>{selectedResult?.test_label || '--'}</span>
            </div>

            {!selectedResult && (
              <p className="text-slate-400 italic flex-1">Select a test case to see its trace.</p>
            )}

            {/* Shown for PASS as well as failures. A passing check's details
                carry the actual measured numbers ("source value = 140 |
                destination value = 140") - that IS the result the tester asked
                the query for, and hiding it behind "nothing to trace" meant a
                successful check displayed no evidence at all. */}
            {selectedResult && (
              <div className="flex-1 space-y-3 text-slate-600 leading-relaxed overflow-y-auto">
                <p className="text-slate-400">Evaluating: {selectedResult.rule_target}</p>
                {selectedResult.evaluated_query && (
                  <p className="text-mastek-warning break-words">
                    [QUERY] {selectedResult.evaluated_query}
                  </p>
                )}
                <p className={`font-semibold ${
                  selectedResult.status === 'PASS' ? 'text-mastek-success' : 'text-red-600'
                }`}>
                  [{selectedResult.status}]{' '}
                  {selectedResult.status === 'PASS'
                    ? 'Assertion held'
                    : (selectedResult.error_message || 'Assertion failed')}
                </p>
                {selectedResult.details && (
                  <p className="bg-slate-50 border border-slate-200 p-2.5 rounded text-slate-700 whitespace-pre-wrap">
                    {selectedResult.details}
                  </p>
                )}
              </div>
            )}

            <div className="pt-2 border-t border-slate-200 flex gap-2">
              <button
                onClick={onBackToS2D}
                className="flex-1 bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 py-2 rounded font-medium text-center flex items-center justify-center gap-1.5 transition"
              >
                <GitCompareArrows className="w-3.5 h-3.5" /> Test Cases Validation
              </button>
              <button
                // Opens THIS check in the editor, rather than dropping the
                // tester on the test-case list to find it again by name.
                onClick={() => onEditTestCase(run.mapping_id, selectedResult.test_case_id)}
                disabled={!selectedResult?.test_case_id}
                title={selectedResult?.test_case_id
                  ? 'Edit this test case'
                  : 'This result has no test case to open - it may have been deleted'}
                className="flex-1 bg-mastek-primary hover:brightness-110 text-white text-center py-2 rounded font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Update Test Query
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
