import { useEffect, useState } from 'react';
import {
  Sparkles, Code2, Plus, Trash2, Loader2, AlertCircle, Rocket, GitCompareArrows,
  Pencil, Play, X,
} from 'lucide-react';
import {
  fetchS2DTestCases, createS2DTestCase, updateS2DTestCase, deleteS2DTestCase,
  runS2DPipeline, runSingleS2DTestCase,
} from '../api';

const VALIDATION_TYPES = [
  'Record Volume Integrity',
  'Null Value Constraint',
  'Regex Pattern Check',
  'Boundary Range Constraint',
  'Custom',
];

const SQL_PLACEHOLDER = `-- Must return exactly one row with a "passed" column (0/1)
-- and optionally a "details" column shown in the error trace.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) + ' null student_id rows found' AS details
FROM students_info
WHERE student_id IS NULL`;

const EMPTY_FORM = {
  name: '', validationType: VALIDATION_TYPES[0], checkType: 'sql',
  target: 'source', targetTable: '', scriptType: 'sql', scriptText: '',
  rowCountSourceTables: [], rowCountDestinationTables: [],
};

function TableCheckboxList({ tables, selected, onToggle }) {
  return (
    <div className="border border-slate-300 rounded-lg max-h-32 overflow-y-auto">
      {tables.length === 0 && <p className="text-sm text-slate-400 italic px-3 py-2">No tables</p>}
      {tables.map((t) => (
        <label key={t} className="flex items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0">
          <input
            type="checkbox"
            checked={selected.includes(t)}
            onChange={() => onToggle(t)}
            className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent shrink-0"
          />
          <span className="truncate">{t}</span>
        </label>
      ))}
    </div>
  );
}

export default function TestCasePanel({ mapping, onRunComplete }) {
  const [tab, setTab] = useState('ai'); // 'ai' | 'manual'

  const [testCases, setTestCases] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const [editingId, setEditingId] = useState(null); // null = creating new
  const [form, setForm] = useState(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const [runningId, setRunningId] = useState(null); // per-row running state
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [runError, setRunError] = useState(null);

  const loadTestCases = () => {
    if (!mapping) return;
    setIsLoading(true);
    fetchS2DTestCases(mapping.id).then((data) => {
      setTestCases(data);
      setIsLoading(false);
    });
  };

  useEffect(loadTestCases, [mapping]);
  useEffect(() => { setEditingId(null); setForm(EMPTY_FORM); }, [mapping]);

  const startEdit = (tc) => {
    setTab('manual');
    setEditingId(tc.id);
    setForm({
      name: tc.name, validationType: tc.validation_type, checkType: tc.check_type,
      target: tc.target || 'source', targetTable: tc.target_table || '',
      scriptType: tc.script_type || 'sql', scriptText: tc.script_text || '',
      rowCountSourceTables: tc.row_count_source_tables || [],
      rowCountDestinationTables: tc.row_count_destination_tables || [],
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const canSave = form.checkType === 'row_count_match'
    ? !!(form.name && form.rowCountSourceTables.length > 0 && form.rowCountDestinationTables.length > 0)
    : !!(form.name && form.scriptText);

  const buildPayload = () => (
    form.checkType === 'row_count_match'
      ? {
          name: form.name, validation_type: form.validationType, check_type: 'row_count_match',
          row_count_source_tables: form.rowCountSourceTables,
          row_count_destination_tables: form.rowCountDestinationTables,
        }
      : {
          name: form.name, validation_type: form.validationType, check_type: 'sql',
          target: form.target, target_table: form.targetTable || null,
          script_type: form.scriptType, script_text: form.scriptText,
        }
  );

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      if (editingId) {
        await updateS2DTestCase(editingId, buildPayload());
      } else {
        await createS2DTestCase(mapping.id, buildPayload());
      }
      cancelEdit();
      loadTestCases();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id) => {
    await deleteS2DTestCase(id);
    if (editingId === id) cancelEdit();
    loadTestCases();
  };

  const handleRunOne = async (id) => {
    setRunningId(id);
    setRunError(null);
    try {
      const { run_id } = await runSingleS2DTestCase(id);
      onRunComplete(run_id);
    } catch (err) {
      setRunError(err.message);
    } finally {
      setRunningId(null);
    }
  };

  const handleRunAll = async () => {
    setIsRunningAll(true);
    setRunError(null);
    try {
      const { run_id } = await runS2DPipeline(mapping.id);
      onRunComplete(run_id);
    } catch (err) {
      setRunError(err.message);
    } finally {
      setIsRunningAll(false);
    }
  };

  const toggleRcTable = (side, table) => {
    const field = side === 'source' ? 'rowCountSourceTables' : 'rowCountDestinationTables';
    setForm((f) => ({
      ...f,
      [field]: f[field].includes(table) ? f[field].filter((t) => t !== table) : [...f[field], table],
    }));
  };

  if (!mapping) {
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        Create or select a mapping on the left to configure validation logic.
      </main>
    );
  }

  const targetTableOptions = form.target === 'source' ? mapping.source_tables : mapping.destination_tables;

  return (
    <main className="flex-1 bg-slate-50 p-6 flex flex-col gap-4 overflow-y-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-800">Logic Configuration</h2>
          <p className="text-sm text-slate-500 font-mono">
            {mapping.source_connector_name}/{mapping.source_tables.join(', ')}
            <span className="text-slate-300 mx-1">&rarr;</span>
            {mapping.destination_connector_name}/{mapping.destination_tables.join(', ')}
          </p>
        </div>

        <div className="bg-white p-1 rounded-lg border border-slate-200 flex gap-1 text-sm font-medium shrink-0">
          <button
            onClick={() => setTab('ai')}
            className={`px-4 py-1.5 rounded-md flex items-center gap-1.5 transition-colors ${
              tab === 'ai' ? 'bg-mastek-primary text-white shadow' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" /> AI Prompt Generator
          </button>
          <button
            onClick={() => setTab('manual')}
            className={`px-4 py-1.5 rounded-md flex items-center gap-1.5 transition-colors ${
              tab === 'manual' ? 'bg-mastek-primary text-white shadow' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" /> Manual Notebook IDE
          </button>
        </div>
      </div>

      {tab === 'ai' && (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-slate-400">
          <Sparkles className="w-8 h-8 mx-auto mb-3 text-mastek-highlight" />
          <p className="font-medium text-slate-500">AI Prompt Generator - coming soon</p>
          <p className="text-sm mt-1">
            This will turn a plain-English description into a validation script automatically.
            Use the Manual Notebook IDE tab for now.
          </p>
        </div>
      )}

      {tab === 'manual' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
          {editingId && (
            <div className="flex items-center justify-between bg-mastek-accent/10 text-mastek-primary text-xs font-medium px-3 py-2 rounded-lg">
              <span>Editing test case</span>
              <button onClick={cancelEdit} className="flex items-center gap-1 hover:underline">
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Test case name"
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
            />
            <select
              value={form.validationType}
              onChange={(e) => setForm((f) => ({ ...f, validationType: e.target.value }))}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
            >
              {VALIDATION_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm border-b border-slate-100 pb-3">
            <span className="text-xs font-medium text-slate-500">Check type:</span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={form.checkType === 'sql'} onChange={() => setForm((f) => ({ ...f, checkType: 'sql' }))}
                className="text-mastek-primary focus:ring-mastek-accent" />
              Custom SQL script
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={form.checkType === 'row_count_match'} onChange={() => setForm((f) => ({ ...f, checkType: 'row_count_match' }))}
                className="text-mastek-primary focus:ring-mastek-accent" />
              <GitCompareArrows className="w-3.5 h-3.5 text-mastek-highlight" />
              Row count match (built-in)
            </label>
          </div>

          {form.checkType === 'row_count_match' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                Sums <code className="font-mono text-xs">COUNT(*)</code> across whichever tables you pick on each
                side, then compares the two totals. Pick any subset of this mapping's tables per side.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1">Source tables</p>
                  <TableCheckboxList
                    tables={mapping.source_tables}
                    selected={form.rowCountSourceTables}
                    onToggle={(t) => toggleRcTable('source', t)}
                  />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1">Destination tables</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={form.rowCountDestinationTables}
                    onToggle={(t) => toggleRcTable('destination', t)}
                  />
                </div>
              </div>
            </div>
          )}

          {form.checkType === 'sql' && (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <span className="text-xs font-medium text-slate-500">Runs against:</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={form.target === 'source'}
                    onChange={() => setForm((f) => ({ ...f, target: 'source', targetTable: '' }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Source
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={form.target === 'destination'}
                    onChange={() => setForm((f) => ({ ...f, target: 'destination', targetTable: '' }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Destination
                </label>

                <select
                  value={form.targetTable}
                  onChange={(e) => setForm((f) => ({ ...f, targetTable: e.target.value }))}
                  className="ml-auto px-2.5 py-1 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                >
                  <option value="">Label as (optional)</option>
                  {targetTableOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={form.scriptType === 'sql'} onChange={() => setForm((f) => ({ ...f, scriptType: 'sql' }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  SQL <span className="text-slate-400">(runs now)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={form.scriptType === 'pyspark'} onChange={() => setForm((f) => ({ ...f, scriptType: 'pyspark' }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  PySpark <span className="text-slate-400">(save only)</span>
                </label>
              </div>

              <textarea
                value={form.scriptText}
                onChange={(e) => setForm((f) => ({ ...f, scriptText: e.target.value }))}
                placeholder={form.scriptType === 'sql' ? SQL_PLACEHOLDER : 'def validate(df):\n    ...'}
                className="w-full h-40 bg-slate-950 text-slate-100 border border-slate-800 rounded-lg p-4 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-mastek-accent"
              />
            </>
          )}

          {saveError && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4" /> {saveError}
            </div>
          )}

          <button
            onClick={handleSave}
            disabled={isSaving || !canSave}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {editingId ? 'Save Changes' : 'Add Test Case'}
          </button>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl flex-1 overflow-hidden flex flex-col shadow-sm">
        <div className="px-5 py-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h3 className="font-semibold text-sm text-slate-700">Test Cases ({testCases.length})</h3>
          <button
            onClick={handleRunAll}
            disabled={isRunningAll || testCases.length === 0}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-success rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunningAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            <span className="hidden sm:inline">Run Integration Test Pipeline</span>
            <span className="sm:hidden">Run All</span>
          </button>
        </div>

        {runError && (
          <div className="flex items-center gap-2 text-sm text-red-600 px-5 py-2">
            <AlertCircle className="w-4 h-4" /> {runError}
          </div>
        )}

        <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 p-5">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          )}
          {!isLoading && testCases.length === 0 && (
            <p className="p-5 text-sm text-slate-400 italic">
              No test cases yet - add one using the Manual Notebook IDE above.
            </p>
          )}
          {testCases.map((tc, i) => (
            <div key={tc.id} className="flex items-center gap-3 px-5 py-3">
              <span className="text-xs font-mono text-slate-400 w-14 shrink-0">TC-{String(i + 1).padStart(3, '0')}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-700 truncate">{tc.name}</p>
                <p className="text-xs text-slate-400">
                  {tc.validation_type} &middot;{' '}
                  {tc.check_type === 'row_count_match'
                    ? `row count: ${tc.row_count_source_tables.length} src / ${tc.row_count_destination_tables.length} dest table(s)`
                    : `${tc.script_type} on ${tc.target}${tc.target_table ? ` (${tc.target_table})` : ''}`}
                </p>
              </div>
              <button
                onClick={() => handleRunOne(tc.id)}
                disabled={runningId === tc.id}
                className="p-1.5 text-slate-400 hover:text-mastek-success hover:bg-mastek-success/10 rounded-lg shrink-0"
                title="Run just this test case"
              >
                {runningId === tc.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              </button>
              <button
                onClick={() => startEdit(tc)}
                className="p-1.5 text-slate-400 hover:text-mastek-primary hover:bg-mastek-primary/10 rounded-lg shrink-0"
                title="Edit"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDelete(tc.id)}
                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg shrink-0"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}