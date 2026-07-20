import { useEffect, useState } from 'react';
import {
  Sparkles, Code2, Plus, Trash2, Loader2, AlertCircle, Rocket, GitCompareArrows,
  Pencil, Play, X, FileCode2, Wand2, User,
} from 'lucide-react';
import {
  fetchS2DTestCases, createS2DTestCase, updateS2DTestCase, deleteS2DTestCase,
  runS2DPipeline, runSingleS2DTestCase, fetchContainerTables, generateAITestCase,
  generateAISuggestedRules, generateAISuggestedParityRules, generateKeyColumnSuggestion,
  setS2DTestCaseActive,
} from '../api';

const SEVERITY_STYLES = {
  critical: 'bg-red-100 text-red-700',
  error: 'bg-red-50 text-red-600',
  warning: 'bg-amber-100 text-amber-700',
};

const VALIDATION_TYPES = [
  'Null Value Constraint',
  'Boundary Range Constraint',
  'Regex Pattern Check',
  'Uniqueness Constraint',
  'Length Constraint',
  'Categorical Constraint',
  'Referential Integrity',
  'Data Freshness',
  'Record Volume Integrity',
  'Custom',
];

// column_parity only supports metrics that can be computed independently on
// each side and compared - null count, distinct count, min/max range.
const PARITY_VALIDATION_TYPES = ['Null Value Constraint', 'Uniqueness Constraint', 'Boundary Range Constraint'];

// One dialect for everything now: Local runs on DuckDB directly, and
// Fabric connects through DuckDB's mssql extension (attached to the same
// SQL Analytics Endpoint the old pyodbc path used, just via an access
// token) - verified end-to-end against a real Fabric workspace, including
// GROUP BY/HAVING, LENGTH(), regexp_matches(), and duckdb_tables()/
// duckdb_columns() schema introspection all translating correctly.
// Every template leaves <table_name>/<column_name>/etc as literal
// placeholders for the user to fill in by hand - the table name should be
// copied exactly from the dropdown (already correctly quoted for Fabric's
// dotted/reserved-word table names), not retyped from memory.
const PREBUILT_TEMPLATES = {
  null_check: {
    label: 'Null Check',
    validationType: 'Null Value Constraint',
    sql: `SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' null values found in <column_name>' AS details
FROM <table_name>
WHERE <column_name> IS NULL`,
  },
  range_check: {
    label: 'Range Check',
    validationType: 'Boundary Range Constraint',
    sql: `SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' rows outside expected range' AS details
FROM <table_name>
WHERE <column_name> < <min_value> OR <column_name> > <max_value>`,
  },
  format_check: {
    label: 'Format Check',
    validationType: 'Regex Pattern Check',
    sql: `SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' rows with malformed <column_name>' AS details
FROM <table_name>
WHERE NOT regexp_matches(<column_name>, '<regex_pattern>')`,
  },
  uniqueness_check: {
    label: 'Uniqueness Check',
    validationType: 'Uniqueness Constraint',
    sql: `SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' duplicate <column_name> values found' AS details
FROM (
  SELECT <column_name>
  FROM <table_name>
  GROUP BY <column_name>
  HAVING COUNT(*) > 1
) dupes`,
  },
  length_check: {
    label: 'Length Check',
    validationType: 'Length Constraint',
    sql: `SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' rows with <column_name> length outside <min_length>-<max_length>' AS details
FROM <table_name>
WHERE LENGTH(<column_name>) < <min_length> OR LENGTH(<column_name>) > <max_length>`,
  },
  categorical_check: {
    label: 'Categorical Check',
    validationType: 'Categorical Constraint',
    sql: `SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' rows with <column_name> outside allowed values' AS details
FROM <table_name>
WHERE <column_name> NOT IN ('<value1>', '<value2>', '<value3>')`,
  },
  referential_check: {
    label: 'Referential Check',
    validationType: 'Referential Integrity',
    sql: `-- Both tables must live in the SAME container/connector - one query
-- can't reach across two separate databases.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' <child_table> rows with no matching <parent_table> record' AS details
FROM <child_table> c
WHERE c.<child_column> IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM <parent_table> p WHERE p.<parent_column> = c.<child_column>
  )`,
  },
  recency_check: {
    label: 'Recency Check',
    validationType: 'Data Freshness',
    sql: `SELECT
  CASE WHEN MAX(<date_column>) >= CURRENT_DATE - INTERVAL '<days>' DAY THEN 1 ELSE 0 END AS passed,
  'most recent <date_column>: ' || CAST(MAX(<date_column>) AS VARCHAR) AS details
FROM <table_name>`,
  },
  row_count_check: {
    label: 'Row Count Check',
    validationType: 'Record Volume Integrity',
    sql: `SELECT
  CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' rows found' AS details
FROM <table_name>`,
  },
  custom_sql: {
    label: 'Custom SQL',
    validationType: null,
    sql: '',
  },
  custom_expression: {
    label: 'Custom Expression',
    validationType: null,
    sql: `-- Just fill in the WHERE condition that identifies BAD rows -
-- everything else is already wired up to the passed/details contract.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' rows matched the failing condition' AS details
FROM <table_name>
WHERE <your_condition_identifying_bad_rows>`,
  },
};

const SQL_PLACEHOLDER = `-- Must return exactly one row with a "passed" column (0/1)
-- and optionally a "details" column shown in the error trace.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) + ' null student_id rows found' AS details
FROM students_info
WHERE student_id IS NULL`;

const EMPTY_FORM = {
  name: '', validationType: VALIDATION_TYPES[0], checkType: 'sql', checkScope: 'single_side',
  target: 'source', targetTable: '', targetTables: [], scriptType: 'sql', scriptText: '',
  rowCountSourceTables: [], rowCountDestinationTables: [],
  sourceTables: [], sourceColumn: '', destinationTables: [], destinationColumn: '',
  sourceTargetTables: [], destinationTargetTables: [], keyColumn: '',
};

// Columns present on every one of the given table names - so the picker
// can never suggest a column that doesn't exist everywhere it'll be
// UNION ALL'd together.
function commonColumns(schema, tableNames) {
  if (tableNames.length === 0) return [];
  const columnLists = tableNames
    .map((name) => schema.find((t) => t.name === name)?.columns)
    .filter(Boolean);
  if (columnLists.length === 0) return [];
  const [first, ...rest] = columnLists;
  return first.filter((c) => rest.every((cols) => cols.some((c2) => c2.name === c.name)));
}

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
  const [prebuiltKey, setPrebuiltKey] = useState('custom_sql');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const [runningId, setRunningId] = useState(null); // per-row running state
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [runError, setRunError] = useState(null);
  // AI tab state - separate from the Manual tab's form until generation succeeds
  const [aiMode, setAiMode] = useState('single'); // 'single' | 'parity' | 'cross_parity'
  const [aiTarget, setAiTarget] = useState('source'); // 'source' | 'destination'
  const [aiTables, setAiTables] = useState([]);
  const [isLoadingAiTables, setIsLoadingAiTables] = useState(false);
  const [aiTableNames, setAiTableNames] = useState([]); // multi-select - Generate Test Case can UNION ALL several
  const [aiDescription, setAiDescription] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState(null);
  // Sample-based "AI Suggest Rules" - no description, auto-saves straight away
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(null);
  const [suggestSummary, setSuggestSummary] = useState(null); // { createdCount, skipped }
  const [togglingId, setTogglingId] = useState(null);
  // Column Parity Check tables+columns - fetched once per mapping, shared by
  // the Manual tab's column pickers AND the AI tab's "Source <-> Destination" mode.
  const [sourceSchema, setSourceSchema] = useState([]);
  const [destinationSchema, setDestinationSchema] = useState([]);
  // AI tab "Source <-> Destination" mode - dual-table sample-based suggestion
  const [aiParitySourceTables, setAiParitySourceTables] = useState([]);
  const [aiParityDestinationTables, setAiParityDestinationTables] = useState([]);
  const [isSuggestingParity, setIsSuggestingParity] = useState(false);
  const [suggestParityError, setSuggestParityError] = useState(null);
  const [suggestParitySummary, setSuggestParitySummary] = useState(null); // { createdCount, skipped }
  // AI tab "Cross-Table Parity" mode - AI only suggests a key column + name,
  // no SQL/sampling involved (cross_table_parity is engine-computed); hands
  // off to the Manual tab for review/save, same as 'single' mode's Generate Test Case.
  const [aiCrossSourceTables, setAiCrossSourceTables] = useState([]);
  const [aiCrossDestinationTables, setAiCrossDestinationTables] = useState([]);
  const [aiCrossDescription, setAiCrossDescription] = useState('');
  const [isSuggestingKeyColumn, setIsSuggestingKeyColumn] = useState(false);
  const [suggestKeyColumnError, setSuggestKeyColumnError] = useState(null);


  const loadTestCases = () => {
    if (!mapping) return;


    setIsLoading(true);
    fetchS2DTestCases(mapping.id).then((data) => {
      setTestCases(data);
      setIsLoading(false);
    });
  };

  useEffect(loadTestCases, [mapping]);
  useEffect(() => {
    setEditingId(null); setForm(EMPTY_FORM); setPrebuiltKey('custom_sql');
    setAiTableNames([]); setAiDescription(''); setAiError(null);
    setAiParitySourceTables([]); setAiParityDestinationTables([]);
    setSuggestParityError(null); setSuggestParitySummary(null);
    setAiCrossSourceTables([]); setAiCrossDestinationTables([]); setAiCrossDescription('');
    setSuggestKeyColumnError(null);
  }, [mapping]);

  useEffect(() => {
    if (!mapping) return;
    let cancelled = false;
    const connectorId = aiTarget === 'source' ? mapping.source_connector_id : mapping.destination_connector_id;
    const containerId = aiTarget === 'source' ? mapping.source_container_id : mapping.destination_container_id;
    setIsLoadingAiTables(true);
    setAiTableNames([]);
    fetchContainerTables(connectorId, containerId)
      .then((data) => {
        if (cancelled) return;
        setAiTables(data.tables);
        setIsLoadingAiTables(false);
      })
      .catch(() => { if (!cancelled) setIsLoadingAiTables(false); });
    return () => { cancelled = true; };
  }, [mapping, aiTarget]);

  // Switching mappings quickly (especially away from a slow Fabric mapping)
  // can let an old fetch resolve AFTER a newer one - the cancelled flag
  // stops a stale response from ever overwriting the current mapping's schema.
  useEffect(() => {
    if (!mapping) { setSourceSchema([]); setDestinationSchema([]); return; }
    let cancelled = false;
    fetchContainerTables(mapping.source_connector_id, mapping.source_container_id)
      .then((data) => { if (!cancelled) setSourceSchema(data.tables); })
      .catch(() => { if (!cancelled) setSourceSchema([]); });
    fetchContainerTables(mapping.destination_connector_id, mapping.destination_container_id)
      .then((data) => { if (!cancelled) setDestinationSchema(data.tables); })
      .catch(() => { if (!cancelled) setDestinationSchema([]); });
    return () => { cancelled = true; };
  }, [mapping]);

  const selectedAiTables = aiTables.filter((t) => aiTableNames.includes(t.name));
  const sourceParityColumns = commonColumns(sourceSchema, form.sourceTables);
  const destinationParityColumns = commonColumns(destinationSchema, form.destinationTables);
  const crossParityKeyColumns = commonColumns(sourceSchema, form.sourceTargetTables)
    .filter((c) => commonColumns(destinationSchema, form.destinationTargetTables).some((c2) => c2.name === c.name));

  const toggleAiTableName = (table) => {
    setAiTableNames((prev) => (prev.includes(table) ? prev.filter((t) => t !== table) : [...prev, table]));
  };

  const handleGenerate = async () => {
    if (aiTableNames.length === 0 || !aiDescription || selectedAiTables.length === 0) return;
    setIsGenerating(true);
    setAiError(null);
    try {
      const { sql } = await generateAITestCase({
        checkScope: 'single_side',
        tables: selectedAiTables.map((t) => ({ table_name: t.name, columns: t.columns })),
        description: aiDescription,
      });
      // Hand off to the Manual tab, pre-filled and ready to review/edit -
      // same landing spot prebuilt templates use, so saving works identically.
      setForm((f) => ({
        ...f,
        checkType: 'sql',
        checkScope: 'single_side',
        target: aiTarget,
        targetTables: [...aiTableNames],
        scriptType: 'sql',
        scriptText: sql,
        name: f.name || aiDescription.slice(0, 60),
      }));
      setPrebuiltKey('custom_sql');
      setTab('manual');
    } catch (err) {
      setAiError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSuggestRules = async () => {
    if (aiTableNames.length !== 1) return;
    setIsSuggesting(true);
    setSuggestError(null);
    setSuggestSummary(null);
    try {
      const { created, skipped } = await generateAISuggestedRules(mapping.id, {
        target: aiTarget,
        tableName: aiTableNames[0],
      });
      setSuggestSummary({ createdCount: created.length, skipped });
      loadTestCases();
    } catch (err) {
      setSuggestError(err.message);
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleSuggestParityRules = async () => {
    if (aiParitySourceTables.length === 0 || aiParityDestinationTables.length === 0) return;
    setIsSuggestingParity(true);
    setSuggestParityError(null);
    setSuggestParitySummary(null);
    try {
      const { created, skipped } = await generateAISuggestedParityRules(mapping.id, {
        sourceTables: aiParitySourceTables,
        destinationTables: aiParityDestinationTables,
      });
      setSuggestParitySummary({ createdCount: created.length, skipped });
      loadTestCases();
    } catch (err) {
      setSuggestParityError(err.message);
    } finally {
      setIsSuggestingParity(false);
    }
  };

  const toggleAiParityTable = (side, table) => {
    const setter = side === 'source' ? setAiParitySourceTables : setAiParityDestinationTables;
    setter((prev) => (prev.includes(table) ? prev.filter((t) => t !== table) : [...prev, table]));
  };

  const toggleAiCrossTable = (side, table) => {
    const setter = side === 'source' ? setAiCrossSourceTables : setAiCrossDestinationTables;
    setter((prev) => (prev.includes(table) ? prev.filter((t) => t !== table) : [...prev, table]));
  };

  const handleSuggestKeyColumn = async () => {
    if (aiCrossSourceTables.length === 0 || aiCrossDestinationTables.length === 0 || !aiCrossDescription) return;
    setIsSuggestingKeyColumn(true);
    setSuggestKeyColumnError(null);
    try {
      const toContext = (schema, name) => {
        const t = schema.find((s) => s.name === name);
        return { table_name: name, columns: t ? t.columns : [] };
      };
      const { key_column, name } = await generateKeyColumnSuggestion({
        sourceTables: aiCrossSourceTables.map((n) => toContext(sourceSchema, n)),
        destinationTables: aiCrossDestinationTables.map((n) => toContext(destinationSchema, n)),
        description: aiCrossDescription,
      });
      // Hand off to the Manual tab, pre-filled and ready to review/save -
      // same landing spot the 'single' mode's Generate Test Case uses.
      setForm((f) => ({
        ...f,
        checkType: 'sql',
        checkScope: 'cross_table_parity',
        validationType: 'Custom',
        name: name || f.name || aiCrossDescription.slice(0, 60),
        sourceTargetTables: [...aiCrossSourceTables],
        destinationTargetTables: [...aiCrossDestinationTables],
        keyColumn: key_column,
      }));
      setTab('manual');
    } catch (err) {
      setSuggestKeyColumnError(err.message);
    } finally {
      setIsSuggestingKeyColumn(false);
    }
  };

  const handleToggleActive = async (tc) => {
    setTogglingId(tc.id);
    const nextActive = !tc.active;
    setTestCases((prev) => prev.map((t) => (t.id === tc.id ? { ...t, active: nextActive } : t)));
    try {
      await setS2DTestCaseActive(tc.id, nextActive);
    } catch (err) {
      setTestCases((prev) => prev.map((t) => (t.id === tc.id ? { ...t, active: tc.active } : t)));
      setRunError(err.message);
    } finally {
      setTogglingId(null);
    }
  };

  const startEdit = (tc) => {
    setTab('manual');
    setEditingId(tc.id);
    setPrebuiltKey('custom_sql'); // editing shows the raw saved script, not a template
    setForm({
      name: tc.name, validationType: tc.validation_type, checkType: tc.check_type,
      checkScope: tc.check_scope || 'single_side',
      target: tc.target || 'source', targetTable: tc.target_table || '',
      targetTables: tc.target_tables || (tc.target_table ? [tc.target_table] : []),
      scriptType: tc.script_type || 'sql', scriptText: tc.script_text || '',
      rowCountSourceTables: tc.row_count_source_tables || [],
      rowCountDestinationTables: tc.row_count_destination_tables || [],
      sourceTables: tc.source_tables || [], sourceColumn: tc.source_column || '',
      destinationTables: tc.destination_tables || [], destinationColumn: tc.destination_column || '',
      sourceTargetTables: tc.source_target_tables || [], destinationTargetTables: tc.destination_target_tables || [],
      keyColumn: tc.key_column || '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setPrebuiltKey('custom_sql');
  };

  const isCrossTableParity = form.checkType === 'sql' && form.checkScope === 'cross_table_parity';

  const canSave = form.checkType === 'row_count_match'
    ? !!(form.name && form.rowCountSourceTables.length > 0 && form.rowCountDestinationTables.length > 0)
    : form.checkType === 'column_parity'
    ? !!(form.name && form.sourceTables.length > 0 && form.sourceColumn && form.destinationTables.length > 0 && form.destinationColumn)
    : isCrossTableParity
    ? !!(form.name && form.sourceTargetTables.length > 0 && form.destinationTargetTables.length > 0 && form.keyColumn)
    : !!(form.name && form.targetTables.length > 0 && form.scriptText);

  const buildPayload = () => {
    if (form.checkType === 'row_count_match') {
      return {
        name: form.name, validation_type: form.validationType, check_type: 'row_count_match',
        row_count_source_tables: form.rowCountSourceTables,
        row_count_destination_tables: form.rowCountDestinationTables,
      };
    }
    if (form.checkType === 'column_parity') {
      return {
        name: form.name, validation_type: form.validationType, check_type: 'column_parity',
        source_tables: form.sourceTables, source_column: form.sourceColumn,
        destination_tables: form.destinationTables, destination_column: form.destinationColumn,
      };
    }
    if (isCrossTableParity) {
      return {
        name: form.name, validation_type: form.validationType, check_type: 'sql',
        check_scope: 'cross_table_parity', key_column: form.keyColumn,
        source_target_tables: form.sourceTargetTables, destination_target_tables: form.destinationTargetTables,
      };
    }
    return {
      name: form.name, validation_type: form.validationType, check_type: 'sql', check_scope: 'single_side',
      target: form.target, target_tables: form.targetTables,
      script_type: form.scriptType, script_text: form.scriptText,
    };
  };

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

  const toggleParityTable = (side, table) => {
    const tablesField = side === 'source' ? 'sourceTables' : 'destinationTables';
    const columnField = side === 'source' ? 'sourceColumn' : 'destinationColumn';
    setForm((f) => {
      const nextTables = f[tablesField].includes(table)
        ? f[tablesField].filter((t) => t !== table)
        : [...f[tablesField], table];
      const schema = side === 'source' ? sourceSchema : destinationSchema;
      // Clear the column choice if it's no longer common to every selected table
      const stillValid = commonColumns(schema, nextTables).some((c) => c.name === f[columnField]);
      return { ...f, [tablesField]: nextTables, [columnField]: stillValid ? f[columnField] : '' };
    });
  };

  const toggleTargetTable = (table) => {
    setForm((f) => ({
      ...f,
      targetTables: f.targetTables.includes(table) ? f.targetTables.filter((t) => t !== table) : [...f.targetTables, table],
    }));
  };

  const toggleCrossParityTable = (side, table) => {
    const tablesField = side === 'source' ? 'sourceTargetTables' : 'destinationTargetTables';
    setForm((f) => {
      const nextTables = f[tablesField].includes(table)
        ? f[tablesField].filter((t) => t !== table)
        : [...f[tablesField], table];
      const sourceTables = side === 'source' ? nextTables : f.sourceTargetTables;
      const destinationTables = side === 'destination' ? nextTables : f.destinationTargetTables;
      const stillValid = commonColumns(sourceSchema, sourceTables).some((c) => c.name === f.keyColumn)
        && commonColumns(destinationSchema, destinationTables).some((c) => c.name === f.keyColumn);
      return { ...f, [tablesField]: nextTables, keyColumn: stillValid ? f.keyColumn : '' };
    });
  };

  if (!mapping) {
    return (
      <main className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        Create or select a mapping on the left to configure validation logic.
      </main>
    );
  }

  const targetTableOptions = form.target === 'source' ? mapping.source_tables : mapping.destination_tables;

  const handlePrebuiltChange = (key) => {
    setPrebuiltKey(key);
    const template = PREBUILT_TEMPLATES[key];
    setForm((f) => ({
      ...f,
      scriptType: 'sql',
      scriptText: template.sql,
      validationType: template.validationType || f.validationType,
    }));
  };
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
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-sm">
          <div className="bg-slate-100 p-1 rounded-lg flex gap-1 text-sm font-medium w-fit">
            <button
              onClick={() => setAiMode('single')}
              className={`px-3 py-1 rounded-md transition-colors ${
                aiMode === 'single' ? 'bg-white text-mastek-primary shadow' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Single table
            </button>
            <button
              onClick={() => setAiMode('parity')}
              className={`px-3 py-1 rounded-md flex items-center gap-1.5 transition-colors ${
                aiMode === 'parity' ? 'bg-white text-mastek-primary shadow' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <GitCompareArrows className="w-3.5 h-3.5" /> Source ↔ Destination
            </button>
            <button
              onClick={() => setAiMode('cross_parity')}
              className={`px-3 py-1 rounded-md flex items-center gap-1.5 transition-colors ${
                aiMode === 'cross_parity' ? 'bg-white text-mastek-primary shadow' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <GitCompareArrows className="w-3.5 h-3.5" /> Cross-Table Parity
            </button>
          </div>

          {aiMode === 'single' && (
            <>
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Sparkles className="w-4 h-4 text-mastek-highlight shrink-0" />
                Pick a table, describe the check in plain English, and the AI writes the SQL using this
                table's real columns - it never has to guess a name.
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <span className="text-xs font-medium text-slate-500">Table from:</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={aiTarget === 'source'} onChange={() => setAiTarget('source')}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Source
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={aiTarget === 'destination'} onChange={() => setAiTarget('destination')}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Destination
                </label>
              </div>

              {isLoadingAiTables ? (
                <p className="text-sm text-slate-400 italic">Loading tables...</p>
              ) : (
                <TableCheckboxList
                  tables={aiTables.map((t) => t.name)}
                  selected={aiTableNames}
                  onToggle={toggleAiTableName}
                />
              )}

              {aiTableNames.length > 1 && (
                <p className="text-xs text-mastek-primary">
                  {aiTableNames.length} tables selected - will be combined (UNION ALL) for this check.
                </p>
              )}

              {selectedAiTables.map((t) => (
                <p key={t.name} className="text-xs text-slate-400">
                  <span className="font-mono">{t.name}</span>: {t.columns.map((c) => `${c.name} (${c.data_type})`).join(', ')}
                </p>
              ))}

              <textarea
                value={aiDescription}
                onChange={(e) => setAiDescription(e.target.value)}
                placeholder="e.g. check that the Order ID column has no null values"
                rows={3}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
              />

              {aiError && (
                <div className="flex items-center gap-2 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {aiError}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating || aiTableNames.length === 0 || !aiDescription}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  Generate Test Case
                </button>

                <button
                  onClick={handleSuggestRules}
                  disabled={isSuggesting || aiTableNames.length !== 1}
                  title={aiTableNames.length > 1
                    ? 'Select exactly one table - this flow samples that one table\'s rows'
                    : 'Samples random rows from this table and lets the AI generate several rules on its own - no description needed'}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-mastek-primary bg-mastek-primary/10 rounded-lg hover:bg-mastek-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSuggesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  AI Suggest Rules
                </button>
              </div>

              {suggestError && (
                <div className="flex items-center gap-2 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {suggestError}
                </div>
              )}

              {suggestSummary && (
                <div className="text-sm text-mastek-success">
                  {suggestSummary.createdCount} rule{suggestSummary.createdCount === 1 ? '' : 's'} created from a random sample of {aiTableNames[0]}.
                  {suggestSummary.skipped.length > 0 && (
                    <span className="text-amber-600">
                      {' '}{suggestSummary.skipped.length} skipped (failed the SQL safety check).
                    </span>
                  )}
                </div>
              )}

              <p className="text-xs text-slate-400">
                "Generate Test Case" turns your description into SQL for review in the Manual Notebook IDE tab.
                "AI Suggest Rules" instead samples random rows straight from the table and saves several rules
                automatically - no description, no manual save step. Both are checked against the same safety
                guard every other test case's SQL passes through.
              </p>
            </>
          )}

          {aiMode === 'parity' && (
            <>
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <GitCompareArrows className="w-4 h-4 text-mastek-highlight shrink-0" />
                Pick a source table and a destination table - the AI reads a random sample from both,
                finds columns that are meant to hold the same data, and generates parity checks that
                prove the transfer didn't lose or corrupt anything. This is the real point of S2D validation.
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Source tables</p>
                  <TableCheckboxList
                    tables={mapping.source_tables}
                    selected={aiParitySourceTables}
                    onToggle={(t) => toggleAiParityTable('source', t)}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Destination tables</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={aiParityDestinationTables}
                    onToggle={(t) => toggleAiParityTable('destination', t)}
                  />
                </div>
              </div>

              {suggestParityError && (
                <div className="flex items-center gap-2 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {suggestParityError}
                </div>
              )}

              <button
                onClick={handleSuggestParityRules}
                disabled={isSuggestingParity || aiParitySourceTables.length === 0 || aiParityDestinationTables.length === 0}
                title="Samples random rows from both sides and lets the AI find matching column pairs to compare - no description needed"
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSuggestingParity ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                AI Suggest Parity Rules
              </button>

              {suggestParitySummary && (
                <div className="text-sm text-mastek-success">
                  {suggestParitySummary.createdCount} parity rule{suggestParitySummary.createdCount === 1 ? '' : 's'} created
                  from {aiParitySourceTables.join(', ')} ↔ {aiParityDestinationTables.join(', ')}.
                  {suggestParitySummary.skipped.length > 0 && (
                    <span className="text-amber-600">
                      {' '}{suggestParitySummary.skipped.length} skipped (invalid column/type suggestion).
                    </span>
                  )}
                </div>
              )}

              <p className="text-xs text-slate-400">
                Each saved rule compares a source column against a destination column it identified as
                the same field - no free-form SQL involved, the same null/uniqueness/range comparison
                logic used by the Manual tab's Column Parity Check runs it.
              </p>
            </>
          )}

          {aiMode === 'cross_parity' && (
            <>
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <GitCompareArrows className="w-4 h-4 text-mastek-highlight shrink-0" />
                Pick tables on both sides, describe what you want verified, and the AI picks a shared
                key/join column - the actual comparison then runs as a real row-by-row existence check
                (does every source row's key actually arrive in the destination), not free-form SQL.
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Source tables</p>
                  <TableCheckboxList
                    tables={mapping.source_tables}
                    selected={aiCrossSourceTables}
                    onToggle={(t) => toggleAiCrossTable('source', t)}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Destination tables</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={aiCrossDestinationTables}
                    onToggle={(t) => toggleAiCrossTable('destination', t)}
                  />
                </div>
              </div>

              <textarea
                value={aiCrossDescription}
                onChange={(e) => setAiCrossDescription(e.target.value)}
                placeholder="e.g. verify every order in the source table reached the destination"
                rows={3}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
              />

              {suggestKeyColumnError && (
                <div className="flex items-center gap-2 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4 shrink-0" /> {suggestKeyColumnError}
                </div>
              )}

              <button
                onClick={handleSuggestKeyColumn}
                disabled={isSuggestingKeyColumn || aiCrossSourceTables.length === 0 || aiCrossDestinationTables.length === 0 || !aiCrossDescription}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSuggestingKeyColumn ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                Suggest Key Column
              </button>

              <p className="text-xs text-slate-400">
                Hands off to the Manual Notebook IDE tab with the tables and suggested key column
                pre-filled - review and save there, same as the Single Table generator.
              </p>
            </>
          )}
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
              {(form.checkType === 'column_parity' ? PARITY_VALIDATION_TYPES : VALIDATION_TYPES).map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm border-b border-slate-100 pb-3">
            <span className="text-xs font-medium text-slate-500">Check type:</span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={form.checkType === 'sql' && form.checkScope === 'single_side'}
                onChange={() => setForm((f) => ({ ...f, checkType: 'sql', checkScope: 'single_side' }))}
                className="text-mastek-primary focus:ring-mastek-accent" />
              Custom SQL script
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={form.checkType === 'sql' && form.checkScope === 'cross_table_parity'}
                onChange={() => setForm((f) => ({ ...f, checkType: 'sql', checkScope: 'cross_table_parity', validationType: 'Custom' }))}
                className="text-mastek-primary focus:ring-mastek-accent" />
              <GitCompareArrows className="w-3.5 h-3.5 text-mastek-highlight" />
              Cross-Table Parity (existence check)
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={form.checkType === 'row_count_match'} onChange={() => setForm((f) => ({ ...f, checkType: 'row_count_match' }))}
                className="text-mastek-primary focus:ring-mastek-accent" />
              <GitCompareArrows className="w-3.5 h-3.5 text-mastek-highlight" />
              Row count match (built-in)
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={form.checkType === 'column_parity'}
                onChange={() => setForm((f) => ({
                  ...f, checkType: 'column_parity',
                  validationType: PARITY_VALIDATION_TYPES.includes(f.validationType) ? f.validationType : PARITY_VALIDATION_TYPES[0],
                }))}
                className="text-mastek-primary focus:ring-mastek-accent" />
              <GitCompareArrows className="w-3.5 h-3.5 text-mastek-highlight" />
              Column Parity Check (built-in)
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

          {form.checkType === 'column_parity' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                Computes the same metric (null count, distinct count, or min/max range - based on the
                validation type above) on a source column and a destination column separately, then
                passes only if they match - proving the data reached the destination intact.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-500">Source tables (unioned together)</p>
                  <TableCheckboxList
                    tables={mapping.source_tables}
                    selected={form.sourceTables}
                    onToggle={(t) => toggleParityTable('source', t)}
                  />
                  <select
                    value={form.sourceColumn}
                    onChange={(e) => setForm((f) => ({ ...f, sourceColumn: e.target.value }))}
                    disabled={form.sourceTables.length === 0}
                    className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent disabled:opacity-50"
                  >
                    <option value="">
                      {form.sourceTables.length === 0
                        ? 'Select table(s) first'
                        : sourceParityColumns.length === 0
                        ? 'No column common to all selected tables'
                        : 'Select column'}
                    </option>
                    {sourceParityColumns.map((c) => (
                      <option key={c.name} value={c.name}>{c.name} ({c.data_type})</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-500">Destination tables (unioned together)</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={form.destinationTables}
                    onToggle={(t) => toggleParityTable('destination', t)}
                  />
                  <select
                    value={form.destinationColumn}
                    onChange={(e) => setForm((f) => ({ ...f, destinationColumn: e.target.value }))}
                    disabled={form.destinationTables.length === 0}
                    className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent disabled:opacity-50"
                  >
                    <option value="">
                      {form.destinationTables.length === 0
                        ? 'Select table(s) first'
                        : destinationParityColumns.length === 0
                        ? 'No column common to all selected tables'
                        : 'Select column'}
                    </option>
                    {destinationParityColumns.map((c) => (
                      <option key={c.name} value={c.name}>{c.name} ({c.data_type})</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {isCrossTableParity && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                Fetches every {form.keyColumn ? <code className="font-mono text-xs">{form.keyColumn}</code> : 'key column'} value
                from the source table(s) and the destination table(s) separately, then verifies every source
                row's key actually exists in the destination (and vice versa) - a real existence check, not
                a free-form SQL script.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Source tables</p>
                  <TableCheckboxList
                    tables={mapping.source_tables}
                    selected={form.sourceTargetTables}
                    onToggle={(t) => toggleCrossParityTable('source', t)}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Destination tables</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={form.destinationTargetTables}
                    onToggle={(t) => toggleCrossParityTable('destination', t)}
                  />
                </div>
              </div>
              <select
                value={form.keyColumn}
                onChange={(e) => setForm((f) => ({ ...f, keyColumn: e.target.value }))}
                disabled={form.sourceTargetTables.length === 0 || form.destinationTargetTables.length === 0}
                className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent disabled:opacity-50"
              >
                <option value="">
                  {form.sourceTargetTables.length === 0 || form.destinationTargetTables.length === 0
                    ? 'Select table(s) on both sides first'
                    : crossParityKeyColumns.length === 0
                    ? 'No column common to all selected tables'
                    : 'Select key column'}
                </option>
                {crossParityKeyColumns.map((c) => (
                  <option key={c.name} value={c.name}>{c.name} ({c.data_type})</option>
                ))}
              </select>
            </div>
          )}

          {form.checkType === 'sql' && form.checkScope === 'single_side' && (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <span className="text-xs font-medium text-slate-500">Runs against:</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={form.target === 'source'}
                    onChange={() => setForm((f) => ({ ...f, target: 'source', targetTables: [] }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Source
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={form.target === 'destination'}
                    onChange={() => setForm((f) => ({ ...f, target: 'destination', targetTables: [] }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Destination
                </label>
              </div>

              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Target tables</p>
                <TableCheckboxList
                  tables={targetTableOptions}
                  selected={form.targetTables}
                  onToggle={toggleTargetTable}
                />
                {form.targetTables.length > 1 && (
                  <p className="text-xs text-mastek-primary mt-1">
                    {form.targetTables.length} tables selected - will be combined (UNION ALL) for this check.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <FileCode2 className="w-3.5 h-3.5 text-mastek-highlight shrink-0" />
                <select
                  value={prebuiltKey}
                  onChange={(e) => handlePrebuiltChange(e.target.value)}
                  className="flex-1 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                >
                  {Object.entries(PREBUILT_TEMPLATES).map(([key, t]) => (
                    <option key={key} value={key}>{t.label}</option>
                  ))}
                </select>
              </div>
              {prebuiltKey !== 'custom_sql' && (
                <p className="text-xs text-slate-400 -mt-2">
                  Fill in <code className="font-mono">&lt;table_name&gt;</code> and any other{' '}
                  <code className="font-mono">&lt;...&gt;</code> placeholders below yourself - copy the table name
                  exactly from the dropdown above rather than retyping it, since Fabric table names are sometimes
                  quoted (e.g. dotted names from auto-loaded files).
                </p>
              )}

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

        <div className="overflow-auto flex-1">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500 p-5">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          )}
          {!isLoading && testCases.length === 0 && (
            <p className="p-5 text-sm text-slate-400 italic">
              No test cases yet - add one using the Manual Notebook IDE above, or click "AI Suggest Rules" on the AI tab.
            </p>
          )}
          {!isLoading && testCases.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs font-medium text-slate-400 border-b border-slate-100 sticky top-0 bg-white">
                <tr>
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Table</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Origin</th>
                  <th className="px-3 py-2 font-medium">Severity</th>
                  <th className="px-3 py-2 font-medium">Active</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {testCases.map((tc) => (
                  <tr key={tc.id} className={tc.active === false ? 'opacity-50' : ''}>
                    <td className="px-5 py-3 min-w-0 max-w-xs">
                      <p className="font-medium text-slate-700 truncate">{tc.name}</p>
                      {tc.description && (
                        <p className="text-xs text-slate-400 truncate">{tc.description}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">
                      {tc.check_type === 'row_count_match'
                        ? `${tc.row_count_source_tables.length} src / ${tc.row_count_destination_tables.length} dest`
                        : tc.check_type === 'column_parity'
                        ? `${(tc.source_tables || []).join(', ')}.${tc.source_column} ↔ ${(tc.destination_tables || []).join(', ')}.${tc.destination_column}`
                        : tc.check_scope === 'cross_table_parity'
                        ? `${(tc.source_target_tables || []).join(', ')} ↔ ${(tc.destination_target_tables || []).join(', ')} (key: ${tc.key_column})`
                        : ((tc.target_tables && tc.target_tables.join(', ')) || tc.target_table || tc.target || '—')}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">{tc.validation_type}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                        tc.origin === 'ai' ? 'bg-mastek-primary/10 text-mastek-primary' : 'bg-slate-100 text-slate-600'
                      }`}>
                        {tc.origin === 'ai' ? <Sparkles className="w-3 h-3" /> : <User className="w-3 h-3" />}
                        {tc.origin === 'ai' ? 'AI' : 'Manual'}
                      </span>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${SEVERITY_STYLES[tc.severity] || SEVERITY_STYLES.error}`}>
                        {tc.severity || 'error'}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        onClick={() => handleToggleActive(tc)}
                        disabled={togglingId === tc.id}
                        role="switch"
                        aria-checked={tc.active !== false}
                        title={tc.active !== false ? 'Active - click to disable' : 'Disabled - click to enable'}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                          tc.active !== false ? 'bg-mastek-primary' : 'bg-slate-300'
                        }`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          tc.active !== false ? 'translate-x-4' : 'translate-x-1'
                        }`} />
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-1">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}