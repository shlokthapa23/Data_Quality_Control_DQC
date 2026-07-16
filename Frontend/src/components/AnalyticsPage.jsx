import { useEffect, useState } from 'react';
import {
  ArrowLeft, CheckCircle2, XCircle, AlertTriangle, Loader2, Search,
} from 'lucide-react';
import { fetchS2DRun } from '../api';

const STATUS_BADGE = {
  PASS: 'bg-mastek-success/10 text-mastek-success border border-mastek-success/30',
  FAIL: 'bg-red-50 text-red-600 border border-red-200',
  ERROR: 'bg-mastek-warning/10 text-mastek-warning border border-mastek-warning/30',
};

export default function AnalyticsPage({ runId, onBackToS2D }) {
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
  const failCount = run.total_checkpoints - run.pass_count;

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
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Overall Status</span>
            {run.status === 'passed' ? (
              <span className="text-2xl font-bold text-mastek-success flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5" /> PASSED
              </span>
            ) : (
              <span className="text-2xl font-bold text-red-600 flex items-center gap-2">
                <XCircle className="w-5 h-5" /> FAILED
                <span className="text-xs font-normal text-slate-400">({failCount} alert{failCount !== 1 ? 's' : ''})</span>
              </span>
            )}
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
              <h3 className="font-bold text-sm text-slate-700">Detailed Gate Assertions</h3>
            </div>
            <div className="overflow-x-auto font-mono text-xs">
              <table className="w-full text-left whitespace-nowrap">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-400 uppercase tracking-wider">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Test ID</th>
                    <th className="px-5 py-3 font-semibold">Rule Target</th>
                    <th className="px-5 py-3 font-semibold">Validation Type</th>
                    <th className="px-5 py-3 font-semibold">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {run.results.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setSelectedResultId(r.id)}
                      className={`cursor-pointer hover:bg-slate-50 ${
                        r.id === selectedResultId ? 'bg-slate-50' : ''
                      } ${r.status !== 'PASS' ? 'border-l-2 border-l-red-400' : ''}`}
                    >
                      <td className="px-5 py-4 font-semibold text-slate-600">{r.test_label}</td>
                      <td className="px-5 py-4 text-slate-600">{r.rule_target}</td>
                      <td className="px-5 py-4 text-slate-400">{r.validation_type}</td>
                      <td className="px-5 py-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${STATUS_BADGE[r.status]}`}>
                          {r.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm font-mono text-xs flex flex-col h-full min-h-[320px]">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2 text-slate-400">
              <span className="font-bold tracking-wide text-red-600 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> ERROR TRACE ANALYSIS
              </span>
              <span>{selectedResult?.test_label || '--'}</span>
            </div>

            {!selectedResult && (
              <p className="text-slate-400 italic flex-1">Select a test case to see its trace.</p>
            )}

            {selectedResult && selectedResult.status === 'PASS' && (
              <p className="text-mastek-success flex-1">✓ This test case passed - nothing to trace.</p>
            )}

            {selectedResult && selectedResult.status !== 'PASS' && (
              <div className="flex-1 space-y-3 text-slate-600 leading-relaxed overflow-y-auto">
                <p className="text-slate-400">Evaluating: {selectedResult.rule_target}</p>
                {selectedResult.evaluated_query && (
                  <p className="text-mastek-warning break-words">
                    [QUERY] {selectedResult.evaluated_query}
                  </p>
                )}
                <p className="text-red-600 font-semibold">
                  [{selectedResult.status}] {selectedResult.error_message || 'Assertion failed'}
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
                disabled
                title="Coming soon: will run a drill-down query to show the exact offending rows"
                className="flex-1 bg-white border border-slate-300 text-slate-400 py-2 rounded font-medium text-center cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <Search className="w-3.5 h-3.5" /> Isolate Bad Rows
              </button>
              <button
                onClick={() => onBackToS2D(run.mapping_id)}
                className="flex-1 bg-mastek-primary hover:brightness-110 text-white text-center py-2 rounded font-medium transition"
              >
                Adjust Logic
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}