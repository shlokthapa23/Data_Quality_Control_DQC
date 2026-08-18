import { useEffect, useState } from 'react';
import {
  ArrowDown, Trash2, Loader2, Plus, ChevronDown, ChevronRight,
  ListChecks, AlertCircle, CheckCircle2, Pencil, Check, X, Columns3,
} from 'lucide-react';
import {
  fetchConnectors, fetchConnectorContainers, fetchContainerTables,
  fetchS2DMappings, createS2DMapping, updateS2DMapping, deleteS2DMapping,
  fetchTestSuitesForMapping, createTestSuite, deleteTestSuite, fetchS2DTestCases,
} from '../api';
import ColumnMapModal from '../components/s2d/ColumnMapModal';
import { formatRowCount, rowCountStyle, rowCountTitle } from '../rowCount';
import { ListFilter } from '../components/common/ListFilter';
import { filterByName, noMatchNote } from '../listFilter';

function EndpointPicker({ label, connectors, endpoint, onChange }) {
  const [containers, setContainers] = useState([]);
  const [containerSource, setContainerSource] = useState(null);
  const [tables, setTables] = useState([]);
  const [isLoadingContainers, setIsLoadingContainers] = useState(false);
  const [isLoadingTables, setIsLoadingTables] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!endpoint.connectorId) return;
    setIsLoadingContainers(true);
    setError(null);
    fetchConnectorContainers(endpoint.connectorId)
      .then((data) => {
        setContainers(data.containers);
        setContainerSource(data.source);
        setIsLoadingContainers(false);
        if (data.containers.length === 1) {
          onChange({ ...endpoint, containerId: data.containers[0].id, containerName: data.containers[0].name, tables: [] });
        }
      })
      .catch((err) => {
        setError(err.message);
        setIsLoadingContainers(false);
      });
  }, [endpoint.connectorId]);

  useEffect(() => {
    if (!endpoint.connectorId || !endpoint.containerId) return;
    setIsLoadingTables(true);
    setError(null);
    // Row counts ride along with the listing, so the tester can size up each
    // table while choosing which ones the validation covers.
    fetchContainerTables(endpoint.connectorId, endpoint.containerId, { includeRowCounts: true })
      .then((data) => {
        setTables(data.tables);
        setIsLoadingTables(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoadingTables(false);
      });
  }, [endpoint.connectorId, endpoint.containerId]);

  const handleConnectorChange = (connectorId) => {
    onChange({ connectorId, connectorName: connectors.find((c) => c.id === connectorId)?.name, containerId: '', containerName: '', tables: [] });
  };

  const handleContainerChange = (containerId) => {
    const container = containers.find((c) => c.id === containerId);
    onChange({ ...endpoint, containerId, containerName: container?.name, tables: [] });
  };

  const [query, setQuery] = useState('');
  const visibleTables = filterByName(tables, query, (t) => t.name);

  const toggleTable = (tableName) => {
    const next = endpoint.tables.includes(tableName)
      ? endpoint.tables.filter((t) => t !== tableName)
      : [...endpoint.tables, tableName];
    onChange({ ...endpoint, tables: next });
  };

  return (
    <div>
      <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">{label}</p>
      <div className="space-y-2">
        <select
          value={endpoint.connectorId}
          onChange={(e) => handleConnectorChange(e.target.value)}
          className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
        >
          <option value="">Select connector</option>
          {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <select
          value={endpoint.containerId}
          onChange={(e) => handleContainerChange(e.target.value)}
          disabled={!endpoint.connectorId || isLoadingContainers}
          className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent disabled:opacity-50"
        >
          <option value="">
            {isLoadingContainers ? 'Loading...' : containers.length === 0 ? 'No containers' : 'Select container'}
          </option>
          {containers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {containerSource === 'harvested' && (
          <p className="text-[11px] text-slate-400 -mt-1">
            Showing the {containers.length} Lakehouse{containers.length === 1 ? '' : 's'} you have
            harvested. Harvest another, or pin on Connect, to see more.
          </p>
        )}

        <ListFilter
          value={query} onChange={setQuery} total={tables.length} shown={visibleTables.length}
          selectedCount={endpoint.tables.length}
          allSelected={visibleTables.length > 0 && visibleTables.every((t) => endpoint.tables.includes(t.name))}
          someSelected={visibleTables.some((t) => endpoint.tables.includes(t.name))}
          onSelectAll={(on) => {
            const names = visibleTables.map((t) => t.name);
            onChange({
              ...endpoint,
              tables: on
                ? [...new Set([...endpoint.tables, ...names])]
                : endpoint.tables.filter((t) => !names.includes(t)),
            });
          }}
        />

        <div className="border border-slate-300 rounded-lg max-h-40 overflow-y-auto">
          {isLoadingTables && (
            <div className="flex items-center gap-2 text-sm text-slate-500 px-3 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading tables...
            </div>
          )}
          {!isLoadingTables && endpoint.containerId && tables.length === 0 && (
            <p className="text-sm text-slate-400 italic px-3 py-2">No tables found</p>
          )}
          {!isLoadingTables && !endpoint.containerId && (
            <p className="text-sm text-slate-400 italic px-3 py-2">Select a container first</p>
          )}
          {!isLoadingTables && tables.length > 0 && visibleTables.length === 0 && (
            <p className="text-sm text-slate-400 italic px-3 py-2">{noMatchNote(query)}</p>
          )}
          {!isLoadingTables && visibleTables.map((t) => (
            <label
              key={t.name}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0"
            >
              <input
                type="checkbox"
                checked={endpoint.tables.includes(t.name)}
                onChange={() => toggleTable(t.name)}
                className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent shrink-0"
              />
              <span className="truncate">{t.name}</span>
              {/* ?? not ||: an empty table's count is 0, and hiding "0" would
                  suppress exactly the case worth noticing. */}
              {t.row_count !== undefined && (
                <span
                  className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ml-auto ${rowCountStyle(t.row_count)}`}
                  title={rowCountTitle(t.row_count)}
                >
                  {formatRowCount(t.row_count)}
                </span>
              )}
              <span className={`text-slate-400 text-xs shrink-0 ${t.row_count === undefined ? 'ml-auto' : ''}`}>
                {t.kind === 'VIEW' ? 'view' : 'table'}
              </span>
            </label>
          ))}
        </div>

        {endpoint.tables.length > 0 && (
          <p className="text-xs text-slate-500">{endpoint.tables.length} table{endpoint.tables.length !== 1 ? 's' : ''} selected</p>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

const EMPTY_ENDPOINT = { connectorId: '', connectorName: '', containerId: '', containerName: '', tables: [] };

/**
 * Tick/untick which tables a side of an existing test layer covers.
 *
 * Purely presentational - the options are fetched by whoever opens the editor,
 * so this adds no effect of its own. Tables already used by a test case are
 * marked, because unticking one silently breaks that check the next time it
 * runs; that's a decision the tester should make knowingly, not discover later.
 */
function EditableTableList({ label, options, selected, usage, onToggle }) {
  const [query, setQuery] = useState('');
  const visible = filterByName(options, query, (t) => t.name);
  const removedInUse = options.filter((t) => !selected.has(t.name) && usage[t.name]);

  return (
    <div>
      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">{label}</p>

      <ListFilter
        value={query} onChange={setQuery} total={options.length} shown={visible.length}
        className="mb-1.5"
        selectedCount={selected.size}
        allSelected={visible.length > 0 && visible.every((t) => selected.has(t.name))}
        someSelected={visible.some((t) => selected.has(t.name))}
        onSelectAll={(on) => {
          const names = visible.map((t) => t.name);
          const next = new Set(selected);
          names.forEach((n) => (on ? next.add(n) : next.delete(n)));
          onToggle([...next]);
        }}
      />

      <div className="border border-slate-200 rounded-lg max-h-44 overflow-y-auto bg-white">
        {options.length === 0 && (
          <p className="text-xs text-slate-400 italic px-3 py-2">No tables found.</p>
        )}
        {options.length > 0 && visible.length === 0 && (
          <p className="text-xs text-slate-400 italic px-3 py-2">{noMatchNote(query)}</p>
        )}
        {visible.map((t) => (
          <label
            key={t.name}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0"
          >
            <input
              type="checkbox"
              checked={selected.has(t.name)}
              onChange={() => onToggle(null, t.name)}
              className="rounded border-slate-300 text-mastek-primary focus:ring-mastek-accent shrink-0"
            />
            <span className="truncate">{t.name}</span>
            {usage[t.name] > 0 && (
              <span
                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-mastek-primary/10 text-mastek-primary"
                title={`${usage[t.name]} test case${usage[t.name] === 1 ? '' : 's'} reference this table`}
              >
                {usage[t.name]} in use
              </span>
            )}
            {t.row_count !== undefined && (
              <span
                className={`shrink-0 ml-auto text-[10px] px-1.5 py-0.5 rounded ${rowCountStyle(t.row_count)}`}
                title={rowCountTitle(t.row_count)}
              >
                {formatRowCount(t.row_count)}
              </span>
            )}
          </label>
        ))}
      </div>

      {removedInUse.length > 0 && (
        <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-700">
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
          Removing {removedInUse.map((t) => t.name).join(', ')} will leave{' '}
          {removedInUse.reduce((n, t) => n + usage[t.name], 0)} test case(s) pointing at a table
          this layer no longer covers.
        </p>
      )}
    </div>
  );
}

function TestSuitesForMapping({ mapping }) {
  const [suites, setSuites] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [suiteName, setSuiteName] = useState('');
  const [suiteDescription, setSuiteDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const load = () => {
    if (!mapping) return;
    setIsLoading(true);
    fetchTestSuitesForMapping(mapping.id)
      .then((data) => {
        setSuites(data);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  };

  useEffect(() => {
    setSuiteName(''); setSuiteDescription(''); setError(null); setSuccess(null);
    load();
  }, [mapping?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    const name = suiteName.trim();
    if (!name || !mapping) return;
    setIsCreating(true);
    setError(null);
    try {
      await createTestSuite(mapping.id, { name, description: suiteDescription.trim() || null, test_case_ids: [] });
      setSuiteName(''); setSuiteDescription('');
      setSuccess(`Created "${name}" — add test cases to it from the Test Cases Validation tab.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this test suite?')) return;
    try {
      await deleteTestSuite(id);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!mapping) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 text-center text-sm text-slate-400">
        Select or create a test layer to manage its test suites.
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
      <h3 className="font-semibold text-sm text-slate-700 flex items-center gap-2 mb-1">
        <ListChecks className="w-4 h-4 text-mastek-primary" />
        Test Suites for "{mapping.name}"
      </h3>
      <p className="text-xs text-slate-400 mb-4">
        Create empty suites here, then go to Test Cases Validation to author test cases and add them into a suite.
      </p>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <input
          value={suiteName}
          onChange={(e) => setSuiteName(e.target.value)}
          placeholder="Suite name"
          className="flex-1 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
        />
        <input
          value={suiteDescription}
          onChange={(e) => setSuiteDescription(e.target.value)}
          placeholder="Description (optional)"
          className="flex-1 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
        />
        <button
          onClick={handleCreate}
          disabled={isCreating || !suiteName.trim()}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {isCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Create
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-600 mb-3">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 text-xs text-mastek-success mb-3">
          <CheckCircle2 className="w-3.5 h-3.5" /> {success}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      )}

      {!isLoading && suites.length === 0 && (
        <p className="text-sm text-slate-400 italic">No test suites yet for this test layer.</p>
      )}

      {!isLoading && suites.length > 0 && (
        <ul className="space-y-1.5">
          {suites.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-slate-700 truncate">{s.name}</p>
                <p className="text-xs text-slate-400 truncate">
                  {s.test_case_count} test case{s.test_case_count === 1 ? '' : 's'}
                  {s.description ? ` · ${s.description}` : ''}
                </p>
              </div>
              <button
                onClick={() => handleDelete(s.id)}
                className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded shrink-0"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MappingsPage() {
  const [mappings, setMappings] = useState([]);
  const [selectedMappingId, setSelectedMappingId] = useState(null);
  const [connectors, setConnectors] = useState([]);
  const [name, setName] = useState('');
  // 'source_to_destination' compares two sides; 'source_only' checks a source
  // on its own, which is how a tester proves a file before it is loaded
  // anywhere - at which point there is no destination to compare against yet.
  const [validationKind, setValidationKind] = useState('source_to_destination');
  const [source, setSource] = useState(EMPTY_ENDPOINT);
  const [destination, setDestination] = useState(EMPTY_ENDPOINT);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showMappings, setShowMappings] = useState(true);
  // The layer currently open for editing: its name, which tables each side
  // covers, and how many test cases already reference each table.
  const [editing, setEditing] = useState(null);
  const [columnMapMappingId, setColumnMapMappingId] = useState(null);

  const loadMappings = () => {
    fetchS2DMappings().then((data) => {
      setMappings(data);
      if (!selectedMappingId && data.length > 0) setSelectedMappingId(data[0].id);
    });
  };

  useEffect(loadMappings, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    fetchConnectors().then(setConnectors);
  }, []);

  const isFormOpen = showForm || mappings.length === 0;
  const sourceOnly = validationKind === 'source_only';
  const isComplete = name && source.connectorId && source.containerId && source.tables.length > 0
    && (sourceOnly
      || (destination.connectorId && destination.containerId && destination.tables.length > 0));

  const handleCreate = async () => {
    if (!isComplete) return;
    setIsSaving(true);
    setError(null);
    try {
      await createS2DMapping({
        name,
        source_connector_id: source.connectorId, source_connector_name: source.connectorName,
        source_container_id: source.containerId, source_container_name: source.containerName,
        source_tables: source.tables,
        validation_kind: validationKind,
        // A source-only validation has no destination at all - not an empty
        // one - so the fields are left off entirely.
        ...(sourceOnly ? {} : {
          destination_connector_id: destination.connectorId, destination_connector_name: destination.connectorName,
          destination_container_id: destination.containerId, destination_container_name: destination.containerName,
          destination_tables: destination.tables,
        }),
      });
      setName('');
      setSource(EMPTY_ENDPOINT);
      setDestination(EMPTY_ENDPOINT);
      setShowForm(false);
      loadMappings();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id) => {
    await deleteS2DMapping(id);
    if (selectedMappingId === id) setSelectedMappingId(null);
    loadMappings();
  };

  /** Every table name a test case points at, however it records them. */
  const tableUsage = (testCases) => {
    const usage = {};
    testCases.forEach((tc) => {
      const named = [
        ...(tc.target_tables || []), ...(tc.source_tables || []), ...(tc.destination_tables || []),
        tc.target_table, tc.source_table, tc.destination_table,
      ].filter(Boolean);
      new Set(named).forEach((name) => { usage[name] = (usage[name] || 0) + 1; });
    });
    return usage;
  };

  // Loading happens here, in the click handler, rather than in an effect
  // watching an "editing" id - this page already carries one setState-in-effect
  // violation and shouldn't gain another.
  const startEdit = async (m) => {
    setError(null);
    setEditing({
      mapping: m,
      name: m.name,
      sourceTables: new Set(m.source_tables),
      destinationTables: new Set(m.destination_tables),
      sourceOptions: [],
      destinationOptions: [],
      usage: {},
      isLoading: true,
      isSaving: false,
    });

    const sourceOnly = m.validation_kind === 'source_only';
    const [source, destination, testCases] = await Promise.all([
      fetchContainerTables(m.source_connector_id, m.source_container_id, { includeRowCounts: true })
        .catch(() => ({ tables: [] })),
      sourceOnly
        ? Promise.resolve({ tables: [] })
        : fetchContainerTables(m.destination_connector_id, m.destination_container_id, { includeRowCounts: true })
          .catch(() => ({ tables: [] })),
      fetchS2DTestCases(m.id).catch(() => []),
    ]);

    // Drop the result if the tester has already moved on to another layer.
    setEditing((prev) => (prev && prev.mapping.id === m.id ? {
      ...prev,
      sourceOptions: source.tables || [],
      destinationOptions: destination.tables || [],
      usage: tableUsage(testCases || []),
      isLoading: false,
    } : prev));
  };

  const cancelEdit = () => setEditing(null);

  // side: 'sourceTables' | 'destinationTables'. Pass `all` to replace the whole
  // selection (select-all / clear), or `one` to flip a single table.
  const toggleEditTable = (side, all, one) => {
    setEditing((prev) => {
      if (!prev) return prev;
      if (all) return { ...prev, [side]: new Set(all) };
      if (all !== null && all !== undefined) return { ...prev, [side]: new Set() };
      const next = new Set(prev[side]);
      next.has(one) ? next.delete(one) : next.add(one);
      return { ...prev, [side]: next };
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const { mapping: m } = editing;
    const trimmed = editing.name.trim();
    if (!trimmed) return;

    const patch = {};
    if (trimmed !== m.name) patch.name = trimmed;

    const nextSource = [...editing.sourceTables];
    if (nextSource.join(' ') !== [...m.source_tables].join(' ')) {
      patch.source_tables = nextSource;
    }
    if (m.validation_kind !== 'source_only') {
      const nextDestination = [...editing.destinationTables];
      if (nextDestination.join(' ') !== [...m.destination_tables].join(' ')) {
        patch.destination_tables = nextDestination;
      }
    }
    if (Object.keys(patch).length === 0) { cancelEdit(); return; }

    setEditing((prev) => (prev ? { ...prev, isSaving: true } : prev));
    try {
      await updateS2DMapping(m.id, patch);
      cancelEdit();
      loadMappings();
    } catch (err) {
      setError(err.message);
      setEditing((prev) => (prev ? { ...prev, isSaving: false } : prev));
    }
  };

  const selectedMapping = mappings.find((m) => m.id === selectedMappingId) || null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-6xl mx-auto">
      {/* Left: mapping list + create form */}
      <div className="space-y-4">
        {mappings.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
            <button
              onClick={() => setShowMappings((v) => !v)}
              className="w-full flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 hover:text-slate-600"
            >
              Test Layers ({mappings.length})
              {showMappings ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {showMappings && (
              <div className="space-y-1.5">
                {mappings.map((m) => (
                  <div
                    key={m.id}
                    onClick={() => editing?.mapping.id !== m.id && setSelectedMappingId(m.id)}
                    className={`group p-2 rounded-lg border text-sm transition-colors ${
                      editing?.mapping.id === m.id ? 'block' : 'flex items-center justify-between cursor-pointer'
                    } ${
                      selectedMappingId === m.id
                        ? 'bg-mastek-primary/5 border-mastek-primary/40'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {editing?.mapping.id === m.id ? (
                      <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          <input
                            autoFocus
                            value={editing.name}
                            onChange={(e) => setEditing((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit();
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            className="flex-1 min-w-0 px-2 py-1 text-sm border border-mastek-primary/40 rounded focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                          />
                          <button
                            onClick={saveEdit}
                            disabled={editing.isSaving || editing.isLoading || !editing.name.trim()
                              || editing.sourceTables.size === 0}
                            className="p-1 text-mastek-success hover:bg-mastek-success/10 rounded shrink-0 disabled:opacity-50"
                            title="Save changes"
                          >
                            {editing.isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="p-1 text-slate-400 hover:text-red-600 rounded shrink-0"
                            title="Cancel"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {editing.isLoading ? (
                          <p className="flex items-center gap-2 text-xs text-slate-500">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the available tables...
                          </p>
                        ) : (
                          <>
                            <EditableTableList
                              label={`Source · ${m.source_container_name}`}
                              options={editing.sourceOptions}
                              selected={editing.sourceTables}
                              usage={editing.usage}
                              onToggle={(all, one) => toggleEditTable('sourceTables', all, one)}
                            />
                            {m.validation_kind !== 'source_only' && (
                              <EditableTableList
                                label={`Destination · ${m.destination_container_name}`}
                                options={editing.destinationOptions}
                                selected={editing.destinationTables}
                                usage={editing.usage}
                                onToggle={(all, one) => toggleEditTable('destinationTables', all, one)}
                              />
                            )}
                            <p className="text-[11px] text-slate-400">
                              Newly uploaded files show up here automatically. The connector and
                              container stay fixed &mdash; changing those would make it a different
                              layer and leave every test case pointing at the wrong system.
                            </p>
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="min-w-0">
                          <p className="font-medium text-slate-700 truncate">{m.name}</p>
                          <p className="text-[11px] text-slate-400 font-mono truncate">
                            {m.source_connector_name}/{m.source_tables.length} table{m.source_tables.length !== 1 ? 's' : ''}
                            {' '}&rarr;{' '}
                            {m.destination_connector_name}/{m.destination_tables.length} table{m.destination_tables.length !== 1 ? 's' : ''}
                          </p>
                        </div>
                        {/* Deliberately outside the hover-reveal cluster below:
                            an opt-in feature nobody can see isn't opt-in, it's
                            hidden. The badge shows how many common names are
                            already declared. */}
                        <button
                          onClick={(e) => { e.stopPropagation(); setColumnMapMappingId(m.id); }}
                          className="flex items-center gap-1 p-1 ml-2 text-slate-400 hover:text-mastek-primary shrink-0"
                          title="Map columns - give differently-named columns one common name"
                        >
                          <Columns3 className="w-3.5 h-3.5" />
                          {(m.column_map?.length || 0) > 0 && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-mastek-primary/10 text-mastek-primary">
                              {m.column_map.length}
                            </span>
                          )}
                        </button>
                        <div className="flex items-center opacity-0 group-hover:opacity-100 shrink-0">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit(m); }}
                            className="p-1 text-slate-400 hover:text-mastek-primary"
                            title="Edit - rename, and add or remove the tables this layer covers"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(m.id); }}
                            className="p-1 text-slate-400 hover:text-red-600"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
          <button
            onClick={() => setShowForm((v) => !v)}
            className="w-full flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 hover:text-slate-600"
          >
            Create New Test Layer
            {isFormOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>

          {!isFormOpen && (
            <button
              onClick={() => setShowForm(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-mastek-primary bg-mastek-primary/10 rounded-lg hover:bg-mastek-primary/20"
            >
              <Plus className="w-4 h-4" /> New Test Layer Configuration
            </button>
          )}

          {isFormOpen && (
            <>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Test layer name"
                className="w-full mb-4 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
              />

              <div className="mb-4 grid grid-cols-2 gap-2">
                {[
                  { kind: 'source_to_destination', title: 'Source → Destination',
                    hint: 'Compare two sides — the data moved correctly.' },
                  { kind: 'source_only', title: 'Source only',
                    hint: 'Check a source on its own, before loading it anywhere.' },
                ].map((opt) => (
                  <button
                    key={opt.kind}
                    onClick={() => setValidationKind(opt.kind)}
                    className={`text-left px-3 py-2 rounded-lg border text-xs ${
                      validationKind === opt.kind
                        ? 'border-mastek-primary bg-mastek-primary/5 text-slate-800'
                        : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <span className="block font-medium">{opt.title}</span>
                    <span className="block text-[11px] text-slate-400 mt-0.5">{opt.hint}</span>
                  </button>
                ))}
              </div>

              <EndpointPicker label="1. Source" connectors={connectors} endpoint={source} onChange={setSource} />

              {!sourceOnly && (
                <>
                  <div className="flex justify-center my-3">
                    <ArrowDown className="w-4 h-4 text-slate-300" />
                  </div>

                  <EndpointPicker label="2. Destination" connectors={connectors} endpoint={destination} onChange={setDestination} />
                </>
              )}

              {sourceOnly && (
                <p className="mt-3 text-xs text-slate-400">
                  Checks run against the source alone, so only Custom SQL against that source is
                  available &mdash; there is nothing to compare it with yet. Useful for proving a
                  file&rsquo;s quality before it becomes a Lakehouse table.
                </p>
              )}

              {(source.tables.length > 0 || destination.tables.length > 0) && (
                <div className="mt-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-2">
                  <span className="text-slate-400 block font-semibold">Active Test Layer Rule:</span>
                  <div className="font-mono text-slate-600 bg-white p-2 rounded border border-slate-200 space-y-1">
                    <p className="text-mastek-highlight truncate">
                      {source.tables.length > 0 ? source.tables.join(', ') : '...'}
                    </p>
                    {!sourceOnly && (
                      <>
                        <p className="text-center text-slate-300">&#8595;</p>
                        <p className="text-mastek-accent truncate">
                          {destination.tables.length > 0 ? destination.tables.join(', ') : '...'}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}

              {error && <p className="text-xs text-red-600 mt-3">{error}</p>}

              <button
                onClick={handleCreate}
                disabled={isSaving || !isComplete}
                className="w-full mt-4 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Create Test Layer
              </button>
            </>
          )}
        </div>
      </div>

      {/* Right: test suites for selected mapping */}
      <div>
        <TestSuitesForMapping mapping={selectedMapping} />
      </div>

      {columnMapMappingId && (
        <ColumnMapModal
          mapping={mappings.find((m) => m.id === columnMapMappingId)}
          onClose={() => setColumnMapMappingId(null)}
          onSaved={(updated) => setMappings((ms) => ms.map((m) => (m.id === updated.id ? updated : m)))}
        />
      )}
    </div>
  );
}
