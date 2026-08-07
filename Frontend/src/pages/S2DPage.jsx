import { useEffect, useState } from 'react';
import { GitCompareArrows } from 'lucide-react';
import { fetchS2DMappings } from '../api';
import TestCasePanel from '../components/s2d/TestCasePanel';

export default function S2DPage({ onNavigateToRun, focus }) {
  const [mappings, setMappings] = useState([]);
  const [selectedMappingId, setSelectedMappingId] = useState(null);

  const loadMappings = () => {
    fetchS2DMappings().then((data) => {
      setMappings(data);
      setSelectedMappingId((cur) => {
        if (focus?.mappingId && data.some((m) => m.id === focus.mappingId)) return focus.mappingId;
        if (!cur && data.length > 0) return data[0].id;
        return cur;
      });
    });
  };

  useEffect(loadMappings, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedMapping = mappings.find((m) => m.id === selectedMappingId) || null;

  return (
    <div className="flex flex-col flex-1 overflow-hidden -m-6 sm:-m-8">
      <div className="px-6 sm:px-8 py-4 border-b border-slate-200 bg-white shrink-0">
        <label className="flex items-center gap-3 max-w-xl">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0 flex items-center gap-1.5">
            <GitCompareArrows className="w-3.5 h-3.5" /> Validation
          </span>
          <select
            value={selectedMappingId || ''}
            onChange={(e) => setSelectedMappingId(e.target.value || null)}
            className="flex-1 px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent"
          >
            {mappings.length === 0 && <option value="">No validations yet — create one on the Validation Setup tab</option>}
            {mappings.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
      </div>
      <TestCasePanel
        mapping={selectedMapping}
        onRunComplete={onNavigateToRun}
        focus={focus}
      />
    </div>
  );
}
