import { useEffect, useState } from 'react';
import {
  ArrowDown, Trash2, Loader2, Plus, ChevronDown, ChevronRight,
  ListChecks, AlertCircle, CheckCircle2, Pencil, Check, X, Columns3,
} from 'lucide-react';
import {
  fetchConnectors, fetchConnectorContainers, fetchContainerTables,
  fetchS2DMappings, createS2DMapping, renameS2DMapping, deleteS2DMapping,
  fetchTestSuitesForMapping, createTestSuite, deleteTestSuite,
} from '../api';
import ColumnMapModal from '../components/s2d/ColumnMapModal';
import { formatRowCount, rowCountStyle, rowCountTitle } from '../rowCount';

function EndpointPicker({ label, connectors, endpoint, onChange }) {
  const [containers, setContainers] = useState([]);
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
          {!isLoadingTables && tables.map((t) => (
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
        Select or create a validation to manage its test suites.
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
        <p className="text-sm text-slate-400 italic">No test suites yet for this validation.</p>
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
  const [source, setSource] = useState(EMPTY_ENDPOINT);
  const [destination, setDestination] = useState(EMPTY_ENDPOINT);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showMappings, setShowMappings] = useState(true);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
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
  const isComplete = name && source.connectorId && source.containerId && source.tables.length > 0
    && destination.connectorId && destination.containerId && destination.tables.length > 0;

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
        destination_connector_id: destination.connectorId, destination_connector_name: destination.connectorName,
        destination_container_id: destination.containerId, destination_container_name: destination.containerName,
        destination_tables: destination.tables,
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

  const startRename = (m) => {
    setRenamingId(m.id);
    setRenameValue(m.name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const saveRename = async (id) => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setIsRenaming(true);
    try {
      await renameS2DMapping(id, trimmed);
      cancelRename();
      loadMappings();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsRenaming(false);
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
              Validations ({mappings.length})
              {showMappings ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {showMappings && (
              <div className="space-y-1.5">
                {mappings.map((m) => (
                  <div
                    key={m.id}
                    onClick={() => renamingId !== m.id && setSelectedMappingId(m.id)}
                    className={`group p-2 rounded-lg border flex items-center justify-between cursor-pointer text-sm transition-colors ${
                      selectedMappingId === m.id
                        ? 'bg-mastek-primary/5 border-mastek-primary/40'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {renamingId === m.id ? (
                      <div
                        className="flex items-center gap-1.5 flex-1 min-w-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveRename(m.id);
                            if (e.key === 'Escape') cancelRename();
                          }}
                          className="flex-1 min-w-0 px-2 py-1 text-sm border border-mastek-primary/40 rounded focus:outline-none focus:ring-2 focus:ring-mastek-accent"
                        />
                        <button
                          onClick={() => saveRename(m.id)}
                          disabled={isRenaming || !renameValue.trim()}
                          className="p-1 text-mastek-success hover:bg-mastek-success/10 rounded shrink-0 disabled:opacity-50"
                          title="Save"
                        >
                          {isRenaming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={cancelRename}
                          className="p-1 text-slate-400 hover:text-red-600 rounded shrink-0"
                          title="Cancel"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
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
                            onClick={(e) => { e.stopPropagation(); startRename(m); }}
                            className="p-1 text-slate-400 hover:text-mastek-primary"
                            title="Rename"
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
            Create New Validation
            {isFormOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>

          {!isFormOpen && (
            <button
              onClick={() => setShowForm(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-mastek-primary bg-mastek-primary/10 rounded-lg hover:bg-mastek-primary/20"
            >
              <Plus className="w-4 h-4" /> New Validation Configuration 
            </button>
          )}

          {isFormOpen && (
            <>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Validation name"
                className="w-full mb-4 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
              />

              <EndpointPicker label="1. Source" connectors={connectors} endpoint={source} onChange={setSource} />

              <div className="flex justify-center my-3">
                <ArrowDown className="w-4 h-4 text-slate-300" />
              </div>

              <EndpointPicker label="2. Destination" connectors={connectors} endpoint={destination} onChange={setDestination} />

              {(source.tables.length > 0 || destination.tables.length > 0) && (
                <div className="mt-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-2">
                  <span className="text-slate-400 block font-semibold">Active Validation Rule:</span>
                  <div className="font-mono text-slate-600 bg-white p-2 rounded border border-slate-200 space-y-1">
                    <p className="text-mastek-highlight truncate">
                      {source.tables.length > 0 ? source.tables.join(', ') : '...'}
                    </p>
                    <p className="text-center text-slate-300">&#8595;</p>
                    <p className="text-mastek-accent truncate">
                      {destination.tables.length > 0 ? destination.tables.join(', ') : '...'}
                    </p>
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
                Create Validation
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
