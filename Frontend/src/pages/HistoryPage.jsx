import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, RefreshCw, History as HistoryIcon } from 'lucide-react';
import { fetchS2DRuns } from '../api';

export default function HistoryPage({ onOpenRun }) {
  const [runs, setRuns] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setIsLoading(true);
    fetchS2DRuns()
      .then((data) => {
        setRuns(data);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  };

  useEffect(load, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <HistoryIcon className="w-5 h-5 text-mastek-primary" />
          Test Run History
        </h2>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
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
                <th className="px-6 py-3 font-medium">Validation</th>
                <th className="px-6 py-3 font-medium">Suite</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Checkpoints</th>
                <th className="px-6 py-3 font-medium">Pass / Fail</th>
                <th className="px-6 py-3 font-medium">Compute Time</th>
                <th className="px-6 py-3 font-medium">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {runs.map((run) => (
                <tr
                  key={run.id}
                  onClick={() => onOpenRun(run.id)}
                  className="hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <td className="px-6 py-3 font-medium text-slate-800 truncate max-w-[200px]">
                    {run.mapping_name || '(deleted validation)'}
                  </td>
                  <td className="px-6 py-3 text-slate-500 truncate max-w-[180px]">
                    {run.suite_name || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-6 py-3">
                    {run.status === 'passed' ? (
                      <span className="flex items-center gap-1.5 text-mastek-success text-xs font-semibold">
                        <CheckCircle2 className="w-3.5 h-3.5" /> PASSED
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-red-600 text-xs font-semibold">
                        <XCircle className="w-3.5 h-3.5" /> FAILED
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-slate-500">{run.total_checkpoints}</td>
                  <td className="px-6 py-3 text-slate-500">
                    <span className="text-mastek-success">{run.pass_count}</span>
                    {' / '}
                    <span className="text-red-600">{run.fail_count}</span>
                  </td>
                  <td className="px-6 py-3 text-slate-400 font-mono">{run.compute_time_seconds}s</td>
                  <td className="px-6 py-3 text-slate-400">{new Date(run.started_at).toLocaleString()}</td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-400">
                    No test runs yet - run a pipeline from the Test Cases Validation page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}