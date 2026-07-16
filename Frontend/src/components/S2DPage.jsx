import { useEffect, useState } from 'react';
import { fetchS2DMappings } from '../api';
import MappingPanel from './MappingPanel';
import TestCasePanel from './TestCasePanel';

export default function S2DPage({ onNavigateToRun }) {
  const [mappings, setMappings] = useState([]);
  const [selectedMappingId, setSelectedMappingId] = useState(null);

  const loadMappings = () => {
    fetchS2DMappings().then((data) => {
      setMappings(data);
      if (!selectedMappingId && data.length > 0) setSelectedMappingId(data[0].id);
    });
  };

  useEffect(loadMappings, []);

  const selectedMapping = mappings.find((m) => m.id === selectedMappingId) || null;

  return (
    <div className="flex flex-col lg:flex-row flex-1 overflow-hidden -m-6 sm:-m-8">
      <MappingPanel
        mappings={mappings}
        selectedMappingId={selectedMappingId}
        onSelectMapping={setSelectedMappingId}
        onMappingsChanged={loadMappings}
      />
      <TestCasePanel
        mapping={selectedMapping}
        onRunComplete={onNavigateToRun}
      />
    </div>
  );
}