import { useEffect, useState } from 'react';
import { Database, HardDrive, Trash2, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchConnectors, deleteConnector } from '../api';
import ConnectorForm from '../components/connect/ConnectorForm';
import PinLakehousesPanel from '../components/connect/PinLakehousesPanel';
import LocalFilesPanel from '../components/connect/LocalFilesPanel';

export default function ConnectPage() {
  const [connectors, setConnectors] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const load = () => {
    fetchConnectors()
      .then((data) => {
        setConnectors(data);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setIsLoading(false);
      });
  };

  useEffect(load, []);

  const handleDelete = async (id) => {
    setError(null);
    try {
      await deleteConnector(id);
    } catch (err) {
      if (!err.requiresForce) { setError(err.message); return; }
      // Spell out exactly what goes with it, by name and count - "are you
      // sure?" is not a decision anyone can actually make.
      const layers = err.dependents
        .map((d) => `  - ${d.name} (${d.test_case_count} test case${d.test_case_count === 1 ? '' : 's'})`)
        .join('\n');
      const plural = err.dependents.length === 1 ? '' : 's';
      const ok = confirm(
        `This connector is used by ${err.dependents.length} test layer${plural}:\n\n${layers}\n\n`
        + `Deleting it also deletes ${err.testCaseCount} test case${err.testCaseCount === 1 ? '' : 's'}, `
        + 'along with those layers, their suites and schedules. Run history is kept.\n\n'
        + 'Delete anyway?',
      );
      if (!ok) return;
      try {
        await deleteConnector(id, { force: true });
      } catch (forceErr) {
        setError(forceErr.message);
        return;
      }
    }
    if (expandedId === id) setExpandedId(null);
    load();
  };


  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Connected Sources</h2>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        {!isLoading && !error && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm divide-y divide-slate-100">
            {connectors.length === 0 && (
              <p className="p-6 text-sm text-slate-400 italic">No connectors configured yet.</p>
            )}
            {connectors.map((c) => {
              const isExpanded = expandedId === c.id;
              const Icon = c.type === 'local' ? HardDrive : Database;
              const subtitle = c.type === 'local'
                ? 'Local Files'
               : `Fabric \u00b7 workspace ${c.workspace_id}${c.allowed_containers ? ` \u00b7 ${c.allowed_containers.length} Lakehouse${c.allowed_containers.length !== 1 ? 's' : ''} pinned` : ' \u00b7 not pinned yet'}`;
              return (
                <div key={c.id}>
                  <div className="flex items-center gap-3 px-5 py-3">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : c.id)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      )}
                      <Icon className="w-4 h-4 text-mastek-primary shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{c.name}</p>
                        <p className="text-xs text-slate-400 truncate">{subtitle}</p>
                      </div>
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                      title="Remove connector"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {isExpanded && c.type === 'fabric' && (
                    <PinLakehousesPanel connector={c} onPinned={load} />
                  )}
                  {isExpanded && c.type === 'local' && (
                    <LocalFilesPanel connector={c} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Add a New Connector</h2>
        <ConnectorForm onCreated={load} />
      </div>
    </div>
  );
}