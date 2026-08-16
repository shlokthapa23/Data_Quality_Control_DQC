import { useEffect, useState } from 'react';
import {
  Sparkles, Code2, Plus, Trash2, Loader2, AlertCircle, GitCompareArrows,
  Pencil, Play, X, FileCode2, Wand2, User, ListChecks, CheckCircle2, Columns3,
  Search, ArrowRight, ArrowLeft,
} from 'lucide-react';
import {
  fetchS2DTestCases, createS2DTestCase, updateS2DTestCase, deleteS2DTestCase,
  runSingleS2DTestCase, fetchContainerTables, generateAITestCase, validateS2DSql,
  generateAISuggestedRules, generateAISuggestedParityRules, generateKeyColumnSuggestion,
  generateAISuggestedCrossTableParityRules, setS2DTestCaseActive,
  fetchTestSuitesForMapping, fetchTestSuite, updateTestSuite,
} from '../../api';
import { commonNamesFor } from '../../columnMap';
import { lintSql } from '../../sqlLint';
import { formatRowCount, rowCountStyle, rowCountTitle } from '../../rowCount';
import ColumnMapModal from './ColumnMapModal';

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

// column_parity supports metrics that can be computed independently on each
// side and then compared. Must stay in step with the backend's authoritative
// registry, s2d/engine.py's PARITY_METRICS - the API validates against that, so
// anything listed here but missing there is rejected on save.
// Referential Integrity and Custom are deliberately absent: the first is a join
// within one side (use the referential_check template in Custom SQL mode), the
// second has no defined metric.
const PARITY_VALIDATION_TYPES = [
  'Null Value Constraint',
  'Uniqueness Constraint',
  'Boundary Range Constraint',
  'Record Volume Integrity',
  'Length Constraint',
  'Regex Pattern Check',
  'Data Freshness',
  'Categorical Constraint',
];

// The one parity metric that takes a parameter.
const PARITY_PATTERN_TYPE = 'Regex Pattern Check';

// row_count_match has no metric to choose - the engine never reads
// validation_type for it - so the label is fixed rather than asked for.
const ROW_COUNT_VALIDATION_TYPE = 'Record Volume Integrity';

// What each metric compares, shown under the picker so the tester doesn't have
// to guess. Mirrors ai_service.py's PARITY_METRIC_GUIDE.
const PARITY_METRIC_HINTS = {
  'Null Value Constraint': 'Compares how many NULLs each side has.',
  'Uniqueness Constraint': 'Compares how many DISTINCT values each side has.',
  'Boundary Range Constraint': 'Compares MIN and MAX on each side.',
  'Record Volume Integrity': 'Compares total row count and non-null count.',
  'Length Constraint': 'Compares shortest and longest value length — catches a destination that truncates.',
  'Regex Pattern Check': 'Compares how many values match your regex on each side.',
  'Data Freshness': 'Compares the MAX value — proves the destination is as up to date as the source.',
  'Categorical Constraint': 'Compares the exact SET of distinct values. Use for low-cardinality columns (status codes, flags) — it transports the values themselves, not a count.',
};

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
WHERE <column_name> NOT IN (<allowed_values_list>)`,
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

// Per-template placeholder spec, so the tester never hand-edits <table_name>/
// <column_name>/etc inside the raw SQL - table/column vars render as
// dropdowns sourced from the mapping's already-fetched live schema
// (sourceSchema/destinationSchema, the same data commonColumns() already
// uses for the Column Parity picker - zero extra network cost), everything
// else (a threshold, a regex, an allowed-values list) is a small labeled
// input. custom_sql has no entry here - it's the intentional freehand
// escape hatch and keeps today's raw textarea unchanged.
const TEMPLATE_VARS = {
  null_check: [
    { key: 'table_name', type: 'table', label: 'Table' },
    { key: 'column_name', type: 'column', label: 'Column', tableKey: 'table_name' },
  ],
  range_check: [
    { key: 'table_name', type: 'table', label: 'Table' },
    { key: 'column_name', type: 'column', label: 'Column', tableKey: 'table_name' },
    { key: 'min_value', type: 'text', label: 'Min value' },
    { key: 'max_value', type: 'text', label: 'Max value' },
  ],
  format_check: [
    { key: 'table_name', type: 'table', label: 'Table' },
    { key: 'column_name', type: 'column', label: 'Column', tableKey: 'table_name' },
    { key: 'regex_pattern', type: 'text', label: 'Regex pattern' },
  ],
  uniqueness_check: [
    { key: 'table_name', type: 'table', label: 'Table' },
    { key: 'column_name', type: 'column', label: 'Column', tableKey: 'table_name' },
  ],
  length_check: [
    { key: 'table_name', type: 'table', label: 'Table' },
    { key: 'column_name', type: 'column', label: 'Column', tableKey: 'table_name' },
    { key: 'min_length', type: 'number', label: 'Min length' },
    { key: 'max_length', type: 'number', label: 'Max length' },
  ],
  categorical_check: [
    { key: 'table_name', type: 'table', label: 'Table' },
    { key: 'column_name', type: 'column', label: 'Column', tableKey: 'table_name' },
    { key: 'allowed_values_list', type: 'list', label: 'Allowed values (comma-separated)' },
  ],
  referential_check: [
    // Both tables must live on the SAME side (source or destination) - one
    // query can't reach across two separate database connections.
    { key: 'child_table', type: 'table', label: 'Child table' },
    { key: 'child_column', type: 'column', label: 'Child column', tableKey: 'child_table' },
    { key: 'parent_table', type: 'table', label: 'Parent table' },
    { key: 'parent_column', type: 'column', label: 'Parent column', tableKey: 'parent_table' },
  ],
  recency_check: [
    { key: 'table_name', type: 'table', label: 'Table' },
    { key: 'date_column', type: 'column', label: 'Date column', tableKey: 'table_name' },
    { key: 'days', type: 'number', label: 'Days threshold' },
  ],
  row_count_check: [
    { key: 'table_name', type: 'table', label: 'Table' },
  ],
  custom_expression: [
    { key: 'table_name', type: 'table', label: 'Table' },
    { key: 'your_condition_identifying_bad_rows', type: 'textarea', label: 'Condition identifying BAD rows' },
  ],
};

// Fills in a template's raw SQL from the current variable values. Unset
// vars are left as their literal <key> placeholder so the preview visibly
// shows what's still missing, rather than silently rendering broken SQL.
function renderTemplateSql(templateKey, vars) {
  const template = PREBUILT_TEMPLATES[templateKey];
  if (!template) return '';
  let sql = template.sql;
  for (const varDef of TEMPLATE_VARS[templateKey] || []) {
    const raw = vars[varDef.key];
    if (raw === undefined || raw === null || raw === '') continue;
    const formatted = varDef.type === 'list'
      ? String(raw).split(',').map((v) => v.trim()).filter(Boolean).map((v) => `'${v}'`).join(', ')
      : String(raw);
    sql = sql.split(`<${varDef.key}>`).join(formatted);
  }
  return sql;
}

// Note || for string concat, not + : everything is parsed by DuckDB (Local runs
// it directly, Fabric through the mssql extension), and T-SQL's + on strings
// fails there. This example is the one testers copy, so it has to actually run.
const SQL_PLACEHOLDER = `-- Return "passed" (0/1) for a pass/fail check, plus an
-- optional "details". Or just SELECT a value to measure it.
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS passed,
  CAST(COUNT(*) AS VARCHAR) || ' null student_id rows found' AS details
FROM students_info
WHERE student_id IS NULL`;

// dual_script contract: each side returns ONE row with a "value" column, and
// the engine compares the two values. Deliberately not "passed" - each script
// reports its own side's number and the verdict comes from comparing them,
// which is what lets the two sides live on completely different systems.
const DUAL_SCRIPT_PLACEHOLDER_SOURCE = `-- Runs on the SOURCE connection.
-- Return one row, one column - no alias needed.
SELECT COUNT(DISTINCT customer_id)
FROM source_customers
WHERE status = 'ACTIVE'`;

const DUAL_SCRIPT_PLACEHOLDER_DESTINATION = `-- Runs on the DESTINATION connection.
-- Write it in the destination's own column names - they don't have to match.
SELECT COUNT(DISTINCT "CustomerKey")
FROM "dbo"."dim_customer"
WHERE "Status" = 'ACTIVE'`;

const EMPTY_FORM = {
  name: '', validationType: VALIDATION_TYPES[0], checkType: 'sql', checkScope: 'single_side',
  target: 'source', targetTable: '', targetTables: [], scriptType: 'sql', scriptText: '',
  templateVars: {}, // schema-driven template variables (table/column/etc) - keyed by TEMPLATE_VARS[key].key
  rowCountSourceTables: [], rowCountDestinationTables: [],
  sourceTables: [], sourceColumn: '', destinationTables: [], destinationColumn: '',
  sourceTargetTables: [], destinationTargetTables: [], keyColumn: '',
  parityPattern: '', // Regex Pattern Check only - sent as parity_config.pattern
  destinationScriptText: '', // dual_script only - scriptText holds the source side
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

// Appends the validation's opt-in common names to a list of real columns as
// pseudo-columns, so both drop into the same <select>. A common name is only
// ever passed in here once it covers every selected table (see
// columnMap.js's commonNamesFor), and one that collides with a real column
// name is dropped - the physical column already resolves through the map, and
// two options sharing a value would be indistinguishable to the tester.
function withMappedColumns(literalColumns, mappedNames) {
  const taken = new Set(literalColumns.map((c) => c.name));
  return [
    ...literalColumns,
    ...mappedNames
      .filter((name) => !taken.has(name))
      .map((name) => ({ name, data_type: 'column map', mapped: true })),
  ];
}

/**
 * Instant hints plus a Check syntax button, shared by all three SQL editors.
 *
 * Two layers on purpose. The hints are heuristics and cost nothing, so they show
 * as you type but never block Save. The button is authoritative - it EXPLAINs on
 * the real connector, so it catches misspelled columns and tables that no
 * heuristic can - but opening a Fabric connection takes ~5-9s, which is why it's
 * on demand rather than per keystroke.
 */
function SqlEditorFooter({ hints, onCheck, checkState }) {
  return (
    <div className="mt-1 space-y-1">
      {hints.map((hint) => (
        <p key={hint} className="flex items-start gap-1.5 text-[11px] text-mastek-warning">
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" /> {hint}
        </p>
      ))}
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onCheck}
          disabled={checkState?.busy}
          title="Parses the query against the real database without running it - also catches misspelled column and table names"
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-mastek-primary border border-mastek-primary/40 rounded-md hover:bg-mastek-primary/10 disabled:opacity-50 shrink-0"
        >
          {checkState?.busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
          {checkState?.busy ? 'Checking...' : 'Check syntax'}
        </button>
        {checkState?.ok === true && (
          <p className="flex items-center gap-1 text-[11px] text-mastek-success pt-1">
            <CheckCircle2 className="w-3 h-3 shrink-0" /> Valid against the live schema
          </p>
        )}
        {checkState?.ok === false && (
          <div className="flex-1 pt-1 space-y-1">
            <p className="text-[11px] text-red-600 whitespace-pre-wrap break-words">{checkState.error}</p>
            {/* The database says what's wrong; this says what to change. */}
            {checkState.hint && (
              <p className="flex items-start gap-1.5 text-[11px] text-mastek-primary bg-mastek-primary/5 border border-mastek-primary/20 rounded px-2 py-1">
                <Wand2 className="w-3 h-3 shrink-0 mt-0.5" /> {checkState.hint}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// rowCounts is { tableName: count }. Counts arrive with the schema fetch, so
// while it's in flight a table simply has no entry - deliberately rendered as
// nothing rather than a placeholder, so the list doesn't flicker.
// Note the ?? rather than ||: an empty table's count is 0, which is falsy, and
// hiding "0" would suppress exactly the case a tester most wants to notice.
function TableCheckboxList({ tables, selected, onToggle, rowCounts = {} }) {
  return (
    <div className="border border-slate-300 rounded-lg max-h-32 overflow-y-auto">
      {tables.length === 0 && <p className="text-sm text-slate-400 italic px-3 py-2">No tables</p>}
      {tables.map((t) => {
        const count = rowCounts[t];
        return (
          <label key={t} className="flex items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0">
            <input
              type="checkbox"
              checked={selected.includes(t)}
              onChange={() => onToggle(t)}
              className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent shrink-0"
            />
            <span className="truncate">{t}</span>
            {count !== undefined && (
              <span
                className={`ml-auto shrink-0 text-[11px] px-1.5 py-0.5 rounded ${rowCountStyle(count)}`}
                title={rowCountTitle(count)}
              >
                {formatRowCount(count)}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

export default function TestCasePanel({ mapping, onRunComplete, focus, onMappingUpdated }) {
const [tab, setTab] = useState('ai'); // 'ai' | 'manual'
  const [showColumnMap, setShowColumnMap] = useState(false);

  const [testCases, setTestCases] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const [editingId, setEditingId] = useState(null); // null = creating new
  const [form, setForm] = useState(EMPTY_FORM);
  const [prebuiltKey, setPrebuiltKey] = useState('custom_sql');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const [runningId, setRunningId] = useState(null); // per-row running state
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

  // Add-to-suite selection mode - test suites themselves are created ahead
  // of time on the Mapping tab; this picks an existing one and adds the
  // checked test cases into it.
  const [isSelectingSuite, setIsSelectingSuite] = useState(false);
  const [selectedTestCaseIds, setSelectedTestCaseIds] = useState(new Set());
  const [availableSuites, setAvailableSuites] = useState([]);
  const [isLoadingSuites, setIsLoadingSuites] = useState(false);
  const [targetSuiteId, setTargetSuiteId] = useState('');
  const [isAddingToSuite, setIsAddingToSuite] = useState(false);
  const [suiteError, setSuiteError] = useState(null);
  const [suiteSuccess, setSuiteSuccess] = useState(null);
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
  // "AI Suggested Parity Rules" for cross-table parity - sample-based, no
  // description needed, auto-saves straight away (mirrors aiMode 'parity').
  const [isSuggestingCrossParity, setIsSuggestingCrossParity] = useState(false);
  const [suggestCrossParityError, setSuggestCrossParityError] = useState(null);
  const [suggestCrossParitySummary, setSuggestCrossParitySummary] = useState(null); // { createdCount, skipped }


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
    setSuggestCrossParityError(null); setSuggestCrossParitySummary(null);
    // Skip clearing suite-selection state when a cross-page focus (from the
    // Test Suite Execution's Edit Suite button) is about to open it right back
    // up for this same mapping - otherwise this reset always wins the race
    // against the focus-consuming effect below, since both fire off the
    // same [mapping] change.
    if (!(focus && focus.mappingId === mapping?.id)) {
      setIsSelectingSuite(false); setSelectedTestCaseIds(new Set());
      setAvailableSuites([]); setTargetSuiteId(''); setSuiteError(null); setSuiteSuccess(null);
    }
  }, [mapping]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Row counts come along with the schema so the table pickers can show how
    // big each table is before any test case exists. On Fabric they ride the
    // connection the listing already opens, so they're effectively free.
    const opts = { includeRowCounts: true };
    fetchContainerTables(mapping.source_connector_id, mapping.source_container_id, opts)
      .then((data) => { if (!cancelled) setSourceSchema(data.tables); })
      .catch(() => { if (!cancelled) setSourceSchema([]); });
    fetchContainerTables(mapping.destination_connector_id, mapping.destination_container_id, opts)
      .then((data) => { if (!cancelled) setDestinationSchema(data.tables); })
      .catch(() => { if (!cancelled) setDestinationSchema([]); });
    return () => { cancelled = true; };
  }, [mapping]);

  // name -> row_count, for the pickers. Tables whose count hasn't arrived (or
  // couldn't be read) simply aren't in the map.
  const rowCountsOf = (schema) => Object.fromEntries(
    schema.filter((t) => t.row_count !== undefined).map((t) => [t.name, t.row_count])
  );
  const sourceRowCounts = rowCountsOf(sourceSchema);
  const destinationRowCounts = rowCountsOf(destinationSchema);
  // The freehand Custom SQL picker can offer BOTH sides' tables when they share
  // one connection (see customSqlTableOptions), so it needs both maps.
  const bothSidesRowCounts = { ...sourceRowCounts, ...destinationRowCounts };

  const selectedAiTables = aiTables.filter((t) => aiTableNames.includes(t.name));
  const sourceParityColumns = withMappedColumns(
    commonColumns(sourceSchema, form.sourceTables),
    commonNamesFor(mapping, 'source', form.sourceTables),
  );
  const destinationParityColumns = withMappedColumns(
    commonColumns(destinationSchema, form.destinationTables),
    commonNamesFor(mapping, 'destination', form.destinationTables),
  );
  // A common name qualifies as a cross-table key when the map covers every
  // selected table on BOTH sides - the engine resolves it per table, so the
  // two sides never have to spell the key the same way. That's the case that
  // was previously unselectable no matter what the tester did.
  const crossParityKeyColumns = withMappedColumns(
    commonColumns(sourceSchema, form.sourceTargetTables)
      .filter((c) => commonColumns(destinationSchema, form.destinationTargetTables).some((c2) => c2.name === c.name)),
    commonNamesFor(mapping, 'source', form.sourceTargetTables)
      .filter((name) => commonNamesFor(mapping, 'destination', form.destinationTargetTables).includes(name)),
  );

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
      const { created, skipped, message } = await generateAISuggestedRules(mapping.id, {
        target: aiTarget,
        tableName: aiTableNames[0],
      });
      setSuggestSummary({ createdCount: created.length, skipped, message });
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
      const { created, skipped, message } = await generateAISuggestedParityRules(mapping.id, {
        sourceTables: aiParitySourceTables,
        destinationTables: aiParityDestinationTables,
      });
      setSuggestParitySummary({ createdCount: created.length, skipped, message });
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
        mappingId: mapping.id,
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

  const handleSuggestCrossParityRules = async () => {
    if (aiCrossSourceTables.length === 0 || aiCrossDestinationTables.length === 0) return;
    setIsSuggestingCrossParity(true);
    setSuggestCrossParityError(null);
    setSuggestCrossParitySummary(null);
    try {
      const { created, skipped, message } = await generateAISuggestedCrossTableParityRules(mapping.id, {
        sourceTables: aiCrossSourceTables,
        destinationTables: aiCrossDestinationTables,
      });
      setSuggestCrossParitySummary({ createdCount: created.length, skipped, message });
      loadTestCases();
    } catch (err) {
      setSuggestCrossParityError(err.message);
    } finally {
      setIsSuggestingCrossParity(false);
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
      templateVars: {}, // editing always falls back to the raw-text 'custom_sql' template - we never stored which template/vars produced the saved SQL, only the final string
      rowCountSourceTables: tc.row_count_source_tables || [],
      rowCountDestinationTables: tc.row_count_destination_tables || [],
      sourceTables: tc.source_tables || [], sourceColumn: tc.source_column || '',
      destinationTables: tc.destination_tables || [], destinationColumn: tc.destination_column || '',
      sourceTargetTables: tc.source_target_tables || [], destinationTargetTables: tc.destination_target_tables || [],
      keyColumn: tc.key_column || '',
      parityPattern: tc.parity_config?.pattern || '',
      destinationScriptText: tc.destination_script_text || '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setPrebuiltKey('custom_sql');
  };

  const isCrossTableParity = form.checkType === 'sql' && form.checkScope === 'cross_table_parity';
  // A source-only validation has nothing to compare against, so the two-sided
  // check types aren't offered at all. The API refuses them too - this just
  // stops the tester building something that can only be rejected on save.
  const sourceOnly = mapping?.validation_kind === 'source_only';
  const isDualScript = form.checkType === 'sql' && form.checkScope === 'dual_script';
  // Both scopes live under the one "Custom SQL script" check type - the
  // "Runs against" row picks between them.
  const isCustomSql = form.checkType === 'sql' && !isCrossTableParity;

  // These checks compute one fixed thing, so validation_type is only a label the
  // engine never reads (_run_row_count_match and _run_cross_table_parity_check
  // both ignore it) - which is why the picker is hidden for them. Pinning the
  // label here too stops a stale selection (pick "Length Constraint", then
  // switch to Row count match) being saved and shown in the Results table where
  // the tester can no longer see or correct it.
  const fixedValidationType = form.checkType === 'row_count_match' ? 'Record Volume Integrity'
    : isCrossTableParity ? 'Custom'
    : null;
  const isTemplateMode = form.checkType === 'sql' && form.checkScope === 'single_side' && prebuiltKey !== 'custom_sql';
  const templateVarsComplete = (TEMPLATE_VARS[prebuiltKey] || []).every((v) => {
    const val = form.templateVars[v.key];
    return val !== undefined && val !== null && String(val).trim() !== '';
  });

  const canSave = form.checkType === 'row_count_match'
    ? !!(form.name && form.rowCountSourceTables.length > 0 && form.rowCountDestinationTables.length > 0)
    : form.checkType === 'column_parity'
    ? !!(form.name && form.sourceTables.length > 0 && form.sourceColumn
         && form.destinationTables.length > 0 && form.destinationColumn
         // Regex Pattern Check has nothing to execute without a pattern, and
         // the API rejects it anyway - block it here so the tester finds out
         // before the round trip.
         && (form.validationType !== PARITY_PATTERN_TYPE || form.parityPattern.trim()))
    : isCrossTableParity
    ? !!(form.name && form.sourceTargetTables.length > 0 && form.destinationTargetTables.length > 0 && form.keyColumn)
    : isDualScript
    ? !!(form.name && form.scriptText.trim() && form.destinationScriptText.trim())
    : isTemplateMode
    ? !!(form.name && templateVarsComplete)
    : !!(form.name && form.targetTables.length > 0 && form.scriptText);

  // Per-editor "Check syntax" verdicts, keyed 'source' | 'destination' | 'single'.
  const [sqlCheck, setSqlCheck] = useState({});

  const sourceHints = lintSql(form.scriptText, { scope: form.checkScope });
  const destinationHints = lintSql(form.destinationScriptText, { scope: 'dual_script' });

  const setScript = (editorKey, value) => {
    setForm((f) => (editorKey === 'destination'
      ? { ...f, destinationScriptText: value }
      : { ...f, scriptText: value }));
    // A verdict on the old text says nothing about the new text - clearing it
    // stops a stale green tick vouching for SQL that has since changed.
    setSqlCheck((s) => (s[editorKey] ? { ...s, [editorKey]: undefined } : s));
  };

  const runSyntaxCheck = async (editorKey) => {
    // 'single' validates against whichever side the Runs-against radio picked.
    const target = editorKey === 'single' ? form.target : editorKey;
    const sql = editorKey === 'destination' ? form.destinationScriptText : form.scriptText;
    if (!sql.trim()) return;
    setSqlCheck((s) => ({ ...s, [editorKey]: { busy: true } }));
    try {
      const { ok, error, hint } = await validateS2DSql(mapping.id, { target, sql });
      setSqlCheck((s) => ({ ...s, [editorKey]: { busy: false, ok, error, hint } }));
    } catch (err) {
      // Couldn't run the check at all (connector unreachable) - report it as the
      // check failing, not as the tester's SQL being wrong.
      setSqlCheck((s) => ({ ...s, [editorKey]: { busy: false, ok: false, error: err.message } }));
    }
  };

  const copyScriptAcross = (toDestination) => {
    const from = toDestination ? form.scriptText : form.destinationScriptText;
    const targetKey = toDestination ? 'destinationScriptText' : 'scriptText';
    if (!from.trim()) return;
    const existing = form[targetKey] || '';
    if (existing.trim() && existing !== from
        && !confirm("Replace the other side's script with this one?")) return;
    setForm((f) => ({ ...f, [targetKey]: from }));
    setSqlCheck((s) => ({ ...s, [toDestination ? 'destination' : 'source']: undefined }));
  };

  const buildPayload = () => {
    const validationType = fixedValidationType || form.validationType;
    if (form.checkType === 'row_count_match') {
      return {
        name: form.name, validation_type: validationType, check_type: 'row_count_match',
        row_count_source_tables: form.rowCountSourceTables,
        row_count_destination_tables: form.rowCountDestinationTables,
      };
    }
    if (form.checkType === 'column_parity') {
      return {
        name: form.name, validation_type: form.validationType, check_type: 'column_parity',
        source_tables: form.sourceTables, source_column: form.sourceColumn,
        destination_tables: form.destinationTables, destination_column: form.destinationColumn,
        // Only sent for the metric that actually takes a parameter, so switching
        // away from Regex Pattern Check clears the stored pattern rather than
        // leaving a stale one behind.
        parity_config: form.validationType === PARITY_PATTERN_TYPE
          ? { pattern: form.parityPattern.trim() }
          : null,
      };
    }
    if (isDualScript) {
      return {
        name: form.name, validation_type: form.validationType, check_type: 'sql',
        check_scope: 'dual_script', script_type: form.scriptType,
        script_text: form.scriptText, destination_script_text: form.destinationScriptText,
      };
    }
    if (isCrossTableParity) {
      return {
        name: form.name, validation_type: validationType, check_type: 'sql',
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

  const enterSuiteSelection = () => {
    setIsSelectingSuite(true);
    setSelectedTestCaseIds(new Set());
    setTargetSuiteId('');
    setSuiteError(null); setSuiteSuccess(null);
    if (mapping) {
      setIsLoadingSuites(true);
      fetchTestSuitesForMapping(mapping.id)
        .then((data) => {
          setAvailableSuites(data);
          setIsLoadingSuites(false);
        })
        .catch((err) => {
          setSuiteError(err.message);
          setIsLoadingSuites(false);
        });
    }
  };

  const cancelSuiteSelection = () => {
    setIsSelectingSuite(false);
    setSelectedTestCaseIds(new Set());
    setSuiteError(null);
  };

  const toggleSuiteSelect = (id) => {
    setSelectedTestCaseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Picking a target suite pre-checks its current members - lets the user
  // see (and freely uncheck to remove) what's already in the suite, rather
  // than only being able to add. originalSuiteMemberIds is kept so Save can
  // report how many were added vs removed.
  // Deliberately an explicit function call (from the dropdown's onChange
  // and from the cross-page focus effect) rather than a useEffect keyed on
  // targetSuiteId - a separate reactive effect here raced against
  // enterSuiteSelection's own setSelectedTestCaseIds(new Set()) reset,
  // since both fire from the same "open suite editing" action and their
  // relative order isn't guaranteed once both are effects.
  const [originalSuiteMemberIds, setOriginalSuiteMemberIds] = useState(null);

  const loadSuiteMembers = async (suiteId) => {
    if (!suiteId) { setOriginalSuiteMemberIds(null); return; }
    try {
      const suite = await fetchTestSuite(suiteId);
      const memberIds = suite.test_cases.map((tc) => tc.id);
      setOriginalSuiteMemberIds(memberIds);
      setSelectedTestCaseIds((prev) => new Set([...prev, ...memberIds]));
    } catch (err) {
      setSuiteError(err.message);
    }
  };

  // Cross-page handoff from Test Suite Execution: once this mapping's test
  // cases have finished loading, either open the edit form for a specific
  // test case, or open suite-membership editing pre-targeted at a specific
  // suite. Bails while isLoading is still true (initial mount) and only
  // acts once testCases has actually settled for the focused mapping.
  // Declared after startEdit/enterSuiteSelection/loadSuiteMembers so it can
  // reference them (ESLint's no-use-before-define check is static and
  // doesn't know the callback only runs after the full render completes).
  useEffect(() => {
    if (!focus || !mapping || focus.mappingId !== mapping.id || isLoading) return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      if (focus.testCaseId) {
        const tc = testCases.find((t) => t.id === focus.testCaseId);
        if (tc) startEdit(tc);
      } else if (focus.suiteId) {
        enterSuiteSelection();
        setTargetSuiteId(focus.suiteId);
        loadSuiteMembers(focus.suiteId);
      }
    });
    return () => { cancelled = true; };
  }, [focus, mapping, testCases, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveSuiteMembership = async () => {
    if (!mapping || !targetSuiteId) return;
    if (selectedTestCaseIds.size === 0) { setSuiteError('A suite must keep at least one test case'); return; }

    setIsAddingToSuite(true);
    setSuiteError(null);
    try {
      const finalIds = testCases.filter((tc) => selectedTestCaseIds.has(tc.id)).map((tc) => tc.id);
      const before = new Set(originalSuiteMemberIds || []);
      const after = new Set(finalIds);
      const addedCount = finalIds.filter((id) => !before.has(id)).length;
      const removedCount = (originalSuiteMemberIds || []).filter((id) => !after.has(id)).length;
      const suite = await updateTestSuite(targetSuiteId, { test_case_ids: finalIds });
      const parts = [];
      if (addedCount) parts.push(`added ${addedCount}`);
      if (removedCount) parts.push(`removed ${removedCount}`);
      setSuiteSuccess(
        parts.length
          ? `Saved "${suite.name}" — ${parts.join(', ')}.`
          : `"${suite.name}" is unchanged.`
      );
      setIsSelectingSuite(false);
      setSelectedTestCaseIds(new Set());
      setTargetSuiteId('');
    } catch (err) {
      setSuiteError(err.message);
    } finally {
      setIsAddingToSuite(false);
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
        Select a validation above to configure its test cases, or create one on the Validation Setup tab.
      </main>
    );
  }

  const targetTableOptions = form.target === 'source' ? mapping.source_tables : mapping.destination_tables;
  const templateSchema = form.target === 'source' ? sourceSchema : destinationSchema;

  // Mirrors shares_connection() in s2d/engine.py. A single SQL statement runs
  // inside exactly one connection, so it can only reach both sides when they
  // share a connector AND a container - then joining source to destination is
  // legitimate and the picker offers both lists.
  const sharesConnection = mapping.source_connector_id === mapping.destination_connector_id
    && mapping.source_container_id === mapping.destination_container_id;
  // Only the freehand Custom SQL picker widens. Templates stay on one side:
  // their column dropdowns are fed from that side's schema alone, so offering
  // the other side's tables there would produce empty column lists.
  const customSqlTableOptions = sharesConnection
    ? [...new Set([...mapping.source_tables, ...mapping.destination_tables])]
    : targetTableOptions;

  const handlePrebuiltChange = (key) => {
    setPrebuiltKey(key);
    const template = PREBUILT_TEMPLATES[key];
    setForm((f) => ({
      ...f,
      scriptType: 'sql',
      scriptText: template.sql,
      templateVars: {},
      targetTables: [],
      validationType: template.validationType || f.validationType,
    }));
  };

  // Updates one template variable, keeps form.targetTables in sync with
  // whichever table(s) got picked (so the existing Table-column display and
  // backend contract for check_type='sql' single_side need no changes),
  // clears any column variable whose table just changed under it, and
  // re-derives scriptText from the template right here - synchronous, no
  // extra effect needed, so the read-only preview always matches instantly.
  const setTemplateVar = (varKey, value) => {
    setForm((f) => {
      const varDef = (TEMPLATE_VARS[prebuiltKey] || []).find((v) => v.key === varKey);
      const nextVars = { ...f.templateVars, [varKey]: value };
      if (varDef?.type === 'table') {
        // Clear any column var that depended on this table - it may no
        // longer be valid for the newly-picked table.
        for (const v of TEMPLATE_VARS[prebuiltKey] || []) {
          if (v.tableKey === varKey) delete nextVars[v.key];
        }
      }
      const tableVars = (TEMPLATE_VARS[prebuiltKey] || []).filter((v) => v.type === 'table');
      const nextTargetTables = tableVars.map((v) => nextVars[v.key]).filter(Boolean);
      return {
        ...f,
        templateVars: nextVars,
        targetTables: nextTargetTables,
        scriptText: renderTemplateSql(prebuiltKey, nextVars),
      };
    });
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

        <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => setShowColumnMap(true)}
          title="Map columns - give differently-named columns one common name"
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-mastek-primary border border-mastek-primary/40 rounded-lg hover:bg-mastek-primary/10"
        >
          <Columns3 className="w-4 h-4" /> Map Columns
          {(mapping.column_map?.length || 0) > 0 && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-mastek-primary/10">
              {mapping.column_map.length}
            </span>
          )}
        </button>

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
      </div>

      {showColumnMap && (
        <ColumnMapModal
          mapping={mapping}
          onClose={() => setShowColumnMap(false)}
          onSaved={(updated) => onMappingUpdated?.(updated)}
        />
      )}

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
          <div className="text-xs text-slate-500 -mt-2">
            {aiMode === 'single' && (
              <>Generate SQL checks on one side. Pick a table (or several), describe the rule in plain English, and the AI writes the SQL against real column names.</>
            )}
            {aiMode === 'parity' && (
              <>Auto-generate <strong>column parity</strong> rules from real samples of both sides. Compares stats like null-count and uniqueness column-by-column.</>
            )}
            {aiMode === 'cross_parity' && (
              <>Auto-generate <strong>cross-table parity</strong> rules — the AI picks a shared key column and creates row-level existence checks between source and destination.</>
            )}
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
                  rowCounts={aiTarget === 'source' ? sourceRowCounts : destinationRowCounts}
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

              {suggestSummary && suggestSummary.createdCount === 0 && suggestSummary.message ? (
                <div className="flex items-start gap-2 text-sm text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-3 py-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
                  {suggestSummary.message}
                </div>
              ) : suggestSummary && (
                <div className="text-sm text-mastek-success">
                  {suggestSummary.createdCount} rule{suggestSummary.createdCount === 1 ? '' : 's'} created from a random sample of {aiTableNames[0]}.
                  {suggestSummary.skipped.length > 0 && (
                    <span className="text-amber-600">
                      {' '}{suggestSummary.skipped.length} skipped (failed the SQL safety check or duplicated an existing rule).
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
                    rowCounts={sourceRowCounts}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Destination tables</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={aiParityDestinationTables}
                    onToggle={(t) => toggleAiParityTable('destination', t)}
                    rowCounts={destinationRowCounts}
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

              {suggestParitySummary && suggestParitySummary.createdCount === 0 && suggestParitySummary.message ? (
                <div className="flex items-start gap-2 text-sm text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-3 py-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
                  {suggestParitySummary.message}
                </div>
              ) : suggestParitySummary && (
                <div className="text-sm text-mastek-success">
                  {suggestParitySummary.createdCount} parity rule{suggestParitySummary.createdCount === 1 ? '' : 's'} created
                  from {aiParitySourceTables.join(', ')} ↔ {aiParityDestinationTables.join(', ')}.
                  {suggestParitySummary.skipped.length > 0 && (
                    <span className="text-amber-600">
                      {' '}{suggestParitySummary.skipped.length} skipped (invalid column/type suggestion or duplicated an existing rule).
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
                    rowCounts={sourceRowCounts}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Destination tables</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={aiCrossDestinationTables}
                    onToggle={(t) => toggleAiCrossTable('destination', t)}
                    rowCounts={destinationRowCounts}
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

              <div className="border-t border-slate-200 pt-4 space-y-3">
                <p className="text-xs font-medium text-slate-500">AI Suggested Parity Rules</p>
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Sparkles className="w-4 h-4 text-mastek-highlight shrink-0" />
                  No description needed - the AI samples random rows from both sides above and
                  proposes candidate key columns on its own, saving each straight away as a
                  cross-table parity check (same auto-save flow as Source ↔ Destination).
                </div>

                {suggestCrossParityError && (
                  <div className="flex items-center gap-2 text-sm text-red-600">
                    <AlertCircle className="w-4 h-4 shrink-0" /> {suggestCrossParityError}
                  </div>
                )}

                <button
                  onClick={handleSuggestCrossParityRules}
                  disabled={isSuggestingCrossParity || aiCrossSourceTables.length === 0 || aiCrossDestinationTables.length === 0}
                  title="Samples random rows from both sides and lets the AI propose join/key columns - no description needed"
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSuggestingCrossParity ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  AI Suggest Parity Rules
                </button>

                {suggestCrossParitySummary && suggestCrossParitySummary.createdCount === 0 && suggestCrossParitySummary.message ? (
                  <div className="flex items-start gap-2 text-sm text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-3 py-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
                    {suggestCrossParitySummary.message}
                  </div>
                ) : suggestCrossParitySummary && (
                  <div className="text-sm text-mastek-success">
                    {suggestCrossParitySummary.createdCount} parity rule{suggestCrossParitySummary.createdCount === 1 ? '' : 's'} created
                    from {aiCrossSourceTables.join(', ')} ↔ {aiCrossDestinationTables.join(', ')}.
                    {suggestCrossParitySummary.skipped.length > 0 && (
                      <span className="text-amber-600">
                        {' '}{suggestCrossParitySummary.skipped.length} skipped (invalid key column suggestion or duplicated an existing rule).
                      </span>
                    )}
                  </div>
                )}
              </div>
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

          {/* Row count match has nothing to choose: the check is fully defined by
              the tables you pick, and the engine never reads validation_type for
              it (only column_parity does - see s2d/engine.py's PARITY_METRICS).
              Offering a 10-way dropdown that changes nothing was just noise, so
              it's hidden and the label is fixed to Record Volume Integrity. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Test case name"
              className={`px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent ${
                form.checkType === 'row_count_match' ? 'sm:col-span-2' : ''
              }`}
            />
            {form.checkType !== 'row_count_match' && (
              <select
                value={form.validationType}
                onChange={(e) => setForm((f) => ({ ...f, validationType: e.target.value }))}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
              >
                {(form.checkType === 'column_parity' ? PARITY_VALIDATION_TYPES : VALIDATION_TYPES).map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            )}
          </div>

          <div className="border-b border-slate-100 pb-3">
            <div className="text-xs font-medium text-slate-500 mb-2">Check type — pick what fits your validation:</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {/* Covers both single_side and dual_script - which one you get is
                  chosen by the "Runs against" row below, since that's really a
                  property of a custom script rather than a separate check type. */}
              <label className={`flex items-start gap-2 cursor-pointer p-2 rounded-lg border ${
                isCustomSql ? 'border-mastek-primary bg-mastek-primary/5' : 'border-slate-200 hover:bg-slate-50'
              }`}>
                <input type="radio" checked={isCustomSql}
                  onChange={() => setForm((f) => ({ ...f, checkType: 'sql', checkScope: 'single_side' }))}
                  className="text-mastek-primary focus:ring-mastek-accent mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800">Custom SQL script</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Write your own SQL against one side &mdash; return <code className="font-mono">passed</code>
                    {' '}for a pass/fail check, or just select a value to measure it. Or run it against
                    {' '}<strong>both</strong> sides and have the two results compared.
                  </div>
                </div>
              </label>

              {!sourceOnly && (
              <label className={`flex items-start gap-2 cursor-pointer p-2 rounded-lg border ${
                form.checkType === 'row_count_match'
                  ? 'border-mastek-primary bg-mastek-primary/5' : 'border-slate-200 hover:bg-slate-50'
              }`}>
                <input type="radio" checked={form.checkType === 'row_count_match'}
                  onChange={() => setForm((f) => ({
                    ...f, checkType: 'row_count_match',
                    // Fixed, because the dropdown is hidden for this check type and
                    // the API still requires a non-empty validation_type. This is
                    // exactly what a row count check is.
                    validationType: ROW_COUNT_VALIDATION_TYPE,
                  }))}
                  className="text-mastek-primary focus:ring-mastek-accent mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                    <GitCompareArrows className="w-3.5 h-3.5 text-mastek-highlight" />
                    Row count match
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Compares total row counts between source and destination tables. Fastest, cheapest first check — good for a quick sanity pass.
                  </div>
                </div>
              </label>
              )}

              {!sourceOnly && (
              <label className={`flex items-start gap-2 cursor-pointer p-2 rounded-lg border ${
                form.checkType === 'column_parity'
                  ? 'border-mastek-primary bg-mastek-primary/5' : 'border-slate-200 hover:bg-slate-50'
              }`}>
                <input type="radio" checked={form.checkType === 'column_parity'}
                  onChange={() => setForm((f) => ({
                    ...f, checkType: 'column_parity',
                    validationType: PARITY_VALIDATION_TYPES.includes(f.validationType) ? f.validationType : PARITY_VALIDATION_TYPES[0],
                  }))}
                  className="text-mastek-primary focus:ring-mastek-accent mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                    <GitCompareArrows className="w-3.5 h-3.5 text-mastek-highlight" />
                    Column parity
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Compares one column between source and destination — nulls, distinct values, range, volume,
                    value length, regex matches, category set or freshness. Works across every table you select
                    on each side, and names each table's contribution when it fails.
                  </div>
                </div>
              </label>
              )}

              {!sourceOnly && (
              <label className={`flex items-start gap-2 cursor-pointer p-2 rounded-lg border ${
                form.checkType === 'sql' && form.checkScope === 'cross_table_parity'
                  ? 'border-mastek-primary bg-mastek-primary/5' : 'border-slate-200 hover:bg-slate-50'
              }`}>
                <input type="radio" checked={form.checkType === 'sql' && form.checkScope === 'cross_table_parity'}
                  onChange={() => setForm((f) => ({ ...f, checkType: 'sql', checkScope: 'cross_table_parity', validationType: 'Custom' }))}
                  className="text-mastek-primary focus:ring-mastek-accent mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                    <GitCompareArrows className="w-3.5 h-3.5 text-mastek-highlight" />
                    Cross-table parity
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Checks that every key value on source also exists on destination (and vice versa). Slower but tells you <em>which specific rows</em> are missing.
                  </div>
                </div>
              </label>
              )}

            </div>
          </div>

          {form.checkType === 'row_count_match' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">
                Sums <code className="font-mono text-xs">COUNT(*)</code> across whichever tables you pick on each
                side, then compares the two totals. Pick any subset of this validation's tables per side.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1">Source tables</p>
                  <TableCheckboxList
                    tables={mapping.source_tables}
                    selected={form.rowCountSourceTables}
                    onToggle={(t) => toggleRcTable('source', t)}
                    rowCounts={sourceRowCounts}
                  />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1">Destination tables</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={form.rowCountDestinationTables}
                    onToggle={(t) => toggleRcTable('destination', t)}
                    rowCounts={destinationRowCounts}
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
                    rowCounts={sourceRowCounts}
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
                        ? 'No shared column - try Map Columns'
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
                    rowCounts={destinationRowCounts}
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
                        ? 'No shared column - try Map Columns'
                        : 'Select column'}
                    </option>
                    {destinationParityColumns.map((c) => (
                      <option key={c.name} value={c.name}>{c.name} ({c.data_type})</option>
                    ))}
                  </select>
                </div>
              </div>

              {PARITY_METRIC_HINTS[form.validationType] && (
                <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  <span className="font-medium text-slate-600">{form.validationType}:</span>{' '}
                  {PARITY_METRIC_HINTS[form.validationType]}
                </p>
              )}

              {form.validationType === PARITY_PATTERN_TYPE && (
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1">Regex pattern</p>
                  <input
                    value={form.parityPattern}
                    onChange={(e) => setForm((f) => ({ ...f, parityPattern: e.target.value }))}
                    placeholder="e.g. ^[A-Z]{2}-[0-9]{4}$"
                    className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Counted with DuckDB&rsquo;s <code className="font-mono">regexp_matches</code> on each side; the
                    two counts must match. NULLs are never counted as matches.
                  </p>
                </div>
              )}
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
                    rowCounts={sourceRowCounts}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-slate-500">Destination tables</p>
                  <TableCheckboxList
                    tables={mapping.destination_tables}
                    selected={form.destinationTargetTables}
                    onToggle={(t) => toggleCrossParityTable('destination', t)}
                    rowCounts={destinationRowCounts}
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
                    ? 'No shared key column - try Map Columns'
                    : 'Select key column'}
                </option>
                {crossParityKeyColumns.map((c) => (
                  <option key={c.name} value={c.name}>{c.name} ({c.data_type})</option>
                ))}
              </select>
            </div>
          )}

          {isCustomSql && (
            <>
              {/* One row decides the scope: a single script against one side
                  (single_side, returns "passed"), or one script per side
                  (dual_script, each returns "value" and they're compared). */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <span className="text-xs font-medium text-slate-500">Runs against:</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={!isDualScript && form.target === 'source'}
                    onChange={() => setForm((f) => ({ ...f, checkScope: 'single_side', target: 'source', targetTables: [], templateVars: {} }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Source
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={!isDualScript && form.target === 'destination'}
                    onChange={() => setForm((f) => ({ ...f, checkScope: 'single_side', target: 'destination', targetTables: [], templateVars: {} }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Destination
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={isDualScript}
                    onChange={() => setForm((f) => ({ ...f, checkScope: 'dual_script', scriptType: 'sql' }))}
                    className="text-mastek-primary focus:ring-mastek-accent" />
                  Both sides <span className="text-xs text-slate-400">(compare two scripts)</span>
                </label>
              </div>

              {isDualScript ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">
                  Each script runs on its own side&rsquo;s connection and returns <strong>one row</strong>. If it
                  selects a single column that column is compared &mdash; no alias needed; with several columns,
                  name the one to compare <code className="font-mono text-xs">value</code>. The check passes when
                  the two sides are equal.
                  {!sharesConnection && (
                    <> Source and destination are on different connections here, which is exactly why this is two
                    scripts rather than one &mdash; a single SQL statement can&rsquo;t reach both.</>
                  )}
                </p>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-xs font-medium text-slate-500 truncate">
                        Source script <span className="font-mono text-slate-400">{mapping.source_connector_name}</span>
                      </p>
                      <button
                        type="button"
                        onClick={() => copyScriptAcross(true)}
                        disabled={!form.scriptText.trim()}
                        title="Copy this script into the destination box - the two are often identical"
                        className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-mastek-primary hover:bg-mastek-primary/10 rounded disabled:opacity-40 shrink-0"
                      >
                        Copy to destination <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                    <textarea
                      value={form.scriptText}
                      onChange={(e) => setScript('source', e.target.value)}
                      rows={9}
                      spellCheck={false}
                      placeholder={DUAL_SCRIPT_PLACEHOLDER_SOURCE}
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                    />
                    <SqlEditorFooter
                      hints={sourceHints}
                      onCheck={() => runSyntaxCheck('source')}
                      checkState={sqlCheck.source}
                    />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-xs font-medium text-slate-500 truncate">
                        Destination script <span className="font-mono text-slate-400">{mapping.destination_connector_name}</span>
                      </p>
                      <button
                        type="button"
                        onClick={() => copyScriptAcross(false)}
                        disabled={!form.destinationScriptText.trim()}
                        title="Copy this script into the source box"
                        className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-slate-400 hover:text-mastek-primary hover:bg-mastek-primary/10 rounded disabled:opacity-40 shrink-0"
                      >
                        <ArrowLeft className="w-3 h-3" /> Copy to source
                      </button>
                    </div>
                    <textarea
                      value={form.destinationScriptText}
                      onChange={(e) => setScript('destination', e.target.value)}
                      rows={9}
                      spellCheck={false}
                      placeholder={DUAL_SCRIPT_PLACEHOLDER_DESTINATION}
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                    />
                    <SqlEditorFooter
                      hints={destinationHints}
                      onCheck={() => runSyntaxCheck('destination')}
                      checkState={sqlCheck.destination}
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-400">
                  Available tables &mdash; source: <span className="font-mono">{mapping.source_tables.join(', ')}</span>
                  {' · '}destination: <span className="font-mono">{mapping.destination_tables.join(', ')}</span>
                </p>
              </div>
              ) : (
              <>
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

              {prebuiltKey === 'custom_sql' ? (
                <>
                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">Target tables</p>
                    <TableCheckboxList
                      tables={customSqlTableOptions}
                      selected={form.targetTables}
                      onToggle={toggleTargetTable}
                      rowCounts={bothSidesRowCounts}
                    />
                    {sharesConnection && (
                      <p className="text-xs text-mastek-primary mt-1">
                        Source and destination share one connection, so your script can reference tables from
                        either side &mdash; including joining them together.
                      </p>
                    )}
                    {form.targetTables.length > 1 && (
                      <p className="text-xs text-mastek-primary mt-1">
                        {form.targetTables.length} tables selected - will be combined (UNION ALL) for this check.
                      </p>
                    )}
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
                    onChange={(e) => setScript('single', e.target.value)}
                    placeholder={form.scriptType === 'sql' ? SQL_PLACEHOLDER : 'def validate(df):\n    ...'}
                    className="w-full h-40 bg-slate-950 text-slate-100 border border-slate-800 rounded-lg p-4 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                  />
                  {/* PySpark isn't executable yet, so there's nothing to parse it against. */}
                  {form.scriptType === 'sql' && (
                    <SqlEditorFooter
                      hints={sourceHints}
                      onCheck={() => runSyntaxCheck('single')}
                      checkState={sqlCheck.single}
                    />
                  )}
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-400">
                    Pick the table and column below - the SQL is built for you, no typing required.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(TEMPLATE_VARS[prebuiltKey] || []).map((varDef) => {
                      if (varDef.type === 'table') {
                        return (
                          <label key={varDef.key} className="block">
                            <span className="block text-xs font-medium text-slate-500 mb-1">{varDef.label}</span>
                            <select
                              value={form.templateVars[varDef.key] || ''}
                              onChange={(e) => setTemplateVar(varDef.key, e.target.value)}
                              className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                            >
                              <option value="">Select table</option>
                              {targetTableOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </label>
                        );
                      }
                      if (varDef.type === 'column') {
                        const chosenTable = form.templateVars[varDef.tableKey];
                        const columns = chosenTable ? commonColumns(templateSchema, [chosenTable]) : [];
                        return (
                          <label key={varDef.key} className="block">
                            <span className="block text-xs font-medium text-slate-500 mb-1">{varDef.label}</span>
                            <select
                              value={form.templateVars[varDef.key] || ''}
                              onChange={(e) => setTemplateVar(varDef.key, e.target.value)}
                              disabled={!chosenTable}
                              className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent disabled:opacity-50"
                            >
                              <option value="">{chosenTable ? 'Select column' : 'Select table first'}</option>
                              {columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.data_type})</option>)}
                            </select>
                          </label>
                        );
                      }
                      if (varDef.type === 'textarea') {
                        return (
                          <label key={varDef.key} className="block sm:col-span-2">
                            <span className="block text-xs font-medium text-slate-500 mb-1">{varDef.label}</span>
                            <textarea
                              value={form.templateVars[varDef.key] || ''}
                              onChange={(e) => setTemplateVar(varDef.key, e.target.value)}
                              rows={2}
                              className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                            />
                          </label>
                        );
                      }
                      // 'text' | 'number' | 'list'
                      return (
                        <label key={varDef.key} className="block">
                          <span className="block text-xs font-medium text-slate-500 mb-1">{varDef.label}</span>
                          <input
                            type={varDef.type === 'number' ? 'number' : 'text'}
                            value={form.templateVars[varDef.key] || ''}
                            onChange={(e) => setTemplateVar(varDef.key, e.target.value)}
                            placeholder={varDef.type === 'list' ? 'e.g. Active, Pending, Closed' : undefined}
                            className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                          />
                        </label>
                      );
                    })}
                  </div>

                  <div>
                    <p className="text-xs font-medium text-slate-500 mb-1">Generated SQL (read-only)</p>
                    <textarea
                      value={form.scriptText}
                      readOnly
                      className="w-full h-32 bg-slate-950 text-slate-100 border border-slate-800 rounded-lg p-4 text-sm font-mono cursor-default focus:outline-none"
                    />
                  </div>
                </>
              )}
              </>
              )}
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
          <h3 className="font-semibold text-sm text-slate-700">
            Test Cases ({testCases.length})
            {isSelectingSuite && (
              <span className="ml-2 text-mastek-primary font-normal">
                — {selectedTestCaseIds.size} selected
              </span>
            )}
          </h3>
          <div className="flex items-center gap-2">
            {!isSelectingSuite && (
              <button
                onClick={enterSuiteSelection}
                disabled={testCases.length === 0}
                className="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-mastek-primary border border-mastek-primary/40 rounded-lg hover:bg-mastek-primary/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ListChecks className="w-4 h-4" />
                Edit Test Suite Membership
              </button>
            )}
            {isSelectingSuite && (
              <button
                onClick={cancelSuiteSelection}
                className="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                <X className="w-4 h-4" />
                Cancel
              </button>
            )}
          </div>
        </div>

        {suiteSuccess && !isSelectingSuite && (
          <div className="flex items-center gap-2 text-sm text-mastek-success px-5 py-2 bg-mastek-success/5 border-b border-mastek-success/20">
            <CheckCircle2 className="w-4 h-4" /> {suiteSuccess}
            <button onClick={() => setSuiteSuccess(null)} className="ml-auto text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

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
                  {isSelectingSuite && (
                    <th className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={testCases.length > 0 && selectedTestCaseIds.size === testCases.length}
                        onChange={(e) => setSelectedTestCaseIds(
                          e.target.checked ? new Set(testCases.map((tc) => tc.id)) : new Set()
                        )}
                        className="accent-mastek-primary"
                      />
                    </th>
                  )}
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
                    {isSelectingSuite && (
                      <td className="px-3 py-3 w-8">
                        <input
                          type="checkbox"
                          aria-label={`Select ${tc.name}`}
                          checked={selectedTestCaseIds.has(tc.id)}
                          onChange={() => toggleSuiteSelect(tc.id)}
                          className="accent-mastek-primary"
                        />
                      </td>
                    )}
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

        {isSelectingSuite && (
          <div className="border-t border-slate-200 bg-slate-50 px-5 py-3 flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 min-w-0">
              <label className="block text-xs font-medium text-slate-500 mb-1">Suite</label>
              {isLoadingSuites ? (
                <div className="flex items-center gap-2 text-sm text-slate-400 px-3 py-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading suites...
                </div>
              ) : availableSuites.length === 0 ? (
                <p className="text-sm text-slate-400 italic px-1 py-1.5">
                  No test suites for this validation yet — create one from the Validation Setup tab.
                </p>
              ) : (
                <select
                  value={targetSuiteId}
                  onChange={(e) => { setTargetSuiteId(e.target.value); loadSuiteMembers(e.target.value); }}
                  className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-primary/40"
                >
                  <option value="">Select a suite</option>
                  {availableSuites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.test_case_count} test case{s.test_case_count === 1 ? '' : 's'})</option>
                  ))}
                </select>
              )}
              {targetSuiteId && (
                <p className="text-xs text-slate-400 mt-1">
                  Existing members are pre-checked above — uncheck to remove, check others to add.
                </p>
              )}
            </div>
            <button
              onClick={handleSaveSuiteMembership}
              disabled={isAddingToSuite || selectedTestCaseIds.size === 0 || !targetSuiteId}
              className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:bg-mastek-primary-dark disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {isAddingToSuite ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListChecks className="w-4 h-4" />}
              Save Suite Membership
            </button>
          </div>
        )}
        {suiteError && (
          <div className="flex items-center gap-2 text-sm text-red-600 px-5 py-2 bg-red-50 border-t border-red-100">
            <AlertCircle className="w-4 h-4" /> {suiteError}
          </div>
        )}
      </div>
    </main>
  );
}