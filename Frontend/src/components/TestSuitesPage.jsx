import { useEffect, useState } from 'react';
import {
  ListChecks, Play, Trash2, Loader2, RefreshCw, AlertCircle,
  CheckCircle2, XCircle,
} from 'lucide-react';
import {
  fetchTestSuites, fetchTestSuite, deleteTestSuite, runTestSuite,
  fetchSuiteSchedules, createSuiteSchedule, updateSuiteSchedule,
  deleteSuiteSchedule, fetchSuiteScheduleEvents,
} from '../api';
import SchedulesSection from './SchedulesSection';

const CHECK_TYPE_LABEL = {
  sql: 'SQL',
  row_count_match: 'Row Count',
  column_parity: 'Column Parity',
};

function checkTypeLabel(tc) {
  if (tc.check_type === 'sql' && tc.check_scope === 'cross_table_parity') return 'Cross-Table Parity';
  return CHECK_TYPE_LABEL[tc.check_type] || tc.check_type;
}

export default function TestSuitesPage({ onNavigateToRun }) {
  const [suites, setSuites] = useState([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState(null);
  const [selectedSuite, setSelectedSuite] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const loadSuites = () => setRefreshTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    fetchTestSuites()
      .then((data) => {
        if (cancelled) return;
        setSuites(data);
        setIsLoading(false);
        setSelectedSuiteId((cur) => {
          if (data.length === 0) return null;
          if (cur && data.some((s) => s.id === cur)) return cur;
          return data[0].id;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshTick]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedSuiteId) {
      Promise.resolve().then(() => { if (!cancelled) setSelectedSuite(null); });
      return () => { cancelled = true; };
    }
    Promise.resolve()
      .then(() => { if (!cancelled) setIsDetailLoading(true); })
      .then(() => fetchTestSuite(selectedSuiteId))
      .then((data) => {
        if (cancelled) return;
        setSelectedSuite(data);
        setIsDetailLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setIsDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedSuiteId]);

  const handleRun = async () => {
    if (!selectedSuite) return;
    setIsRunning(true);
    setError(null);
    try {
      const { run_id } = await runTestSuite(selectedSuite.id);
      onNavigateToRun(run_id);
    } catch (err) {
      setError(err.message);
      setIsRunning(false);
    }
  };

  const handleDelete = async (suiteId) => {
    if (!confirm('Delete this test suite? Past run results will remain.')) return;
    try {
      await deleteTestSuite(suiteId);
      if (selectedSuiteId === suiteId) setSelectedSuiteId(null);
      loadSuites();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
          <ListChecks className="w-5 h-5 text-mastek-primary" />
          Test Suites
        </h2>
        <button
          onClick={loadSuites}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500 p-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      )}

      {!isLoading && suites.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-12 text-center">
          <ListChecks className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">
            No test suites yet — create one from a mapping's test-case list on the
            {' '}<span className="font-medium text-slate-700">S2D Validation</span> page.
          </p>
        </div>
      )}

      {!isLoading && suites.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Suite list */}
          <aside className="lg:col-span-1 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 text-xs font-bold text-slate-400 uppercase tracking-wider">
              Suites ({suites.length})
            </div>
            <ul className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
              {suites.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => setSelectedSuiteId(s.id)}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                      selectedSuiteId === s.id ? 'bg-mastek-primary/5 border-l-2 border-mastek-primary' : ''
                    }`}
                  >
                    <div className="text-sm font-medium text-slate-800 truncate">{s.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5 truncate">
                      {s.mapping_name || '(deleted mapping)'}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {s.test_case_count} test case{s.test_case_count === 1 ? '' : 's'}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* Suite detail */}
          <section className="lg:col-span-2 bg-white border border-slate-200 rounded-xl shadow-sm p-5">
            {isDetailLoading && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading suite...
              </div>
            )}
            {!isDetailLoading && selectedSuite && (
              <>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-slate-800 truncate">{selectedSuite.name}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Mapping: <span className="text-slate-700">{selectedSuite.mapping?.name || '(deleted)'}</span>
                    </p>
                    {selectedSuite.description && (
                      <p className="text-sm text-slate-600 mt-2">{selectedSuite.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={handleRun}
                      disabled={isRunning || !selectedSuite.mapping || selectedSuite.test_cases.every((tc) => !tc.active)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:bg-mastek-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                      Run Suite
                    </button>
                    <button
                      onClick={() => handleDelete(selectedSuite.id)}
                      title="Delete suite"
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <SchedulesSection
                  parentId={selectedSuite.id}
                  kind="suite"
                  fetchList={fetchSuiteSchedules}
                  create={createSuiteSchedule}
                  update={updateSuiteSchedule}
                  remove={deleteSuiteSchedule}
                  fetchEvents={fetchSuiteScheduleEvents}
                />

                <div className="mt-4">
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                    Test cases ({selectedSuite.test_cases.length})
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-y border-slate-200 text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Name</th>
                        <th className="text-left px-3 py-2 font-medium">Type</th>
                        <th className="text-left px-3 py-2 font-medium">Severity</th>
                        <th className="text-left px-3 py-2 font-medium">Active</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedSuite.test_cases.map((tc) => (
                        <tr key={tc.id}>
                          <td className="px-3 py-2 text-slate-800 truncate max-w-[300px]">{tc.name}</td>
                          <td className="px-3 py-2 text-slate-500">{checkTypeLabel(tc)}</td>
                          <td className="px-3 py-2 text-slate-500 capitalize">{tc.severity}</td>
                          <td className="px-3 py-2">
                            {tc.active ? (
                              <span className="flex items-center gap-1 text-mastek-success text-xs">
                                <CheckCircle2 className="w-3.5 h-3.5" /> Yes
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-slate-400 text-xs">
                                <XCircle className="w-3.5 h-3.5" /> Skipped
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {selectedSuite.test_cases.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-3 py-6 text-center text-slate-400">
                            No test cases — the underlying rules may have been deleted.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
