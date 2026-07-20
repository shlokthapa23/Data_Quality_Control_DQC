import { useEffect, useState } from 'react';
import { ArrowDown, Trash2, Loader2, Plus, ChevronDown, ChevronRight, ChevronLeft, PanelLeftOpen } from 'lucide-react';
import {
  fetchConnectors, fetchConnectorContainers, fetchContainerTables,
  createS2DMapping, deleteS2DMapping,
} from '../api';

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
    fetchContainerTables(endpoint.connectorId, endpoint.containerId)
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
              <span className="text-slate-400 text-xs shrink-0 ml-auto">{t.kind === 'VIEW' ? 'view' : 'table'}</span>
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

export default function MappingPanel({ mappings, selectedMappingId, onSelectMapping, onMappingsChanged }) {
  const [connectors, setConnectors] = useState([]);
  const [name, setName] = useState('');
  const [source, setSource] = useState(EMPTY_ENDPOINT);
  const [destination, setDestination] = useState(EMPTY_ENDPOINT);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  // Collapsed by default once at least one mapping exists, so the form's
  // two full table checklists don't push TestCasePanel below the fold -
  // still open immediately for a brand-new workspace with nothing to pick yet.
  const [showForm, setShowForm] = useState(false);
  const isFormOpen = showForm || mappings.length === 0;
  // The mapping list itself can also grow long enough to push TestCasePanel
  // out of view - collapsible too, expanded by default since it's the main
  // way to switch mappings.
  const [showMappings, setShowMappings] = useState(true);
  // Collapses the ENTIRE sidebar down to a slim rail, reclaiming all its
  // width for TestCasePanel - independent of the two section-level toggles
  // above, which only matter once the sidebar itself is open.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    fetchConnectors().then(setConnectors);
  }, []);

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
      onMappingsChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id) => {
    await deleteS2DMapping(id);
    if (selectedMappingId === id) onSelectMapping(null);
    onMappingsChanged();
  };

  if (collapsed) {
    return (
      <aside className="w-12 border-r border-slate-200 bg-white flex flex-col items-center py-4 shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand mappings"
          className="p-2 text-slate-400 hover:text-mastek-primary hover:bg-mastek-primary/10 rounded-lg"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-full lg:w-80 max-h-[45vh] lg:max-h-none border-b lg:border-b-0 lg:border-r border-slate-200 bg-white p-4 flex flex-col gap-6 overflow-y-auto shrink-0">
      <div className="flex items-center justify-end -mb-2">
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse"
          className="p-1 text-slate-400 hover:text-mastek-primary hover:bg-mastek-primary/10 rounded"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>

      {mappings.length > 0 && (
        <div>
          <button
            onClick={() => setShowMappings((v) => !v)}
            className="w-full flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 hover:text-slate-600"
          >
            Mappings ({mappings.length})
            {showMappings ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          {showMappings && (
          <div className="space-y-1.5">
            {mappings.map((m) => (
              <div
                key={m.id}
                onClick={() => onSelectMapping(m.id)}
                className={`group p-2 rounded-lg border flex items-center justify-between cursor-pointer text-sm transition-colors ${
                  selectedMappingId === m.id
                    ? 'bg-mastek-primary/5 border-mastek-primary/40'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-700 truncate">{m.name}</p>
                  <p className="text-[11px] text-slate-400 font-mono truncate">
                    {m.source_connector_name}/{m.source_tables.length} table{m.source_tables.length !== 1 ? 's' : ''}
                    {' '}&rarr;{' '}
                    {m.destination_connector_name}/{m.destination_tables.length} table{m.destination_tables.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(m.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      <div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="w-full flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 hover:text-slate-600"
        >
          New Mapping
          {isFormOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>

        {!isFormOpen && (
          <button
            onClick={() => setShowForm(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-mastek-primary bg-mastek-primary/10 rounded-lg hover:bg-mastek-primary/20"
          >
            <Plus className="w-4 h-4" /> New Mapping
          </button>
        )}

        {isFormOpen && (
          <>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mapping name"
              className="w-full mb-4 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
            />

            <EndpointPicker label="1. Source" connectors={connectors} endpoint={source} onChange={setSource} />

            <div className="flex justify-center my-3">
              <ArrowDown className="w-4 h-4 text-slate-300" />
            </div>

            <EndpointPicker label="2. Destination" connectors={connectors} endpoint={destination} onChange={setDestination} />

            {(source.tables.length > 0 || destination.tables.length > 0) && (
              <div className="mt-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-2">
                <span className="text-slate-400 block font-semibold">Active Mapping Rule:</span>
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
              Create Mapping
            </button>
          </>
        )}
      </div>
    </aside>
  );
}