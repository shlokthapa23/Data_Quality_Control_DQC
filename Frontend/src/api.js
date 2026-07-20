const API_BASE = 'http://127.0.0.1:5000';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.details ? `${body.error}: ${body.details}` : (body.error || `Request failed: ${res.status}`);
    throw new Error(message);
  }
  return body;
}

// --- Connectors ---

export function fetchConnectors() {
  return request('/api/connectors');
}

export function createConnector(payload) {
  return request('/api/connectors', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteConnector(id) {
  return request(`/api/connectors/${id}`, { method: 'DELETE' });
}

export function testConnector(id) {
  return request(`/api/connectors/${id}/test`, { method: 'POST' });
}

export function testConnectorDraft(payload) {
  return request('/api/connectors/test-draft', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchConnectorItems(id) {
  return request(`/api/connectors/${id}/items`);
}

export function fetchAllLakehouses(connectorId) {
  return request(`/api/connectors/${connectorId}/lakehouses`);
}

export function fetchConnectorContainers(connectorId) {
  return request(`/api/connectors/${connectorId}/containers`);
}

export function pinConnectorContainers(connectorId, containers) {
  return request(`/api/connectors/${connectorId}/pin-containers`, {
    method: 'POST',
    body: JSON.stringify({ containers }),
  });
}

export function fetchContainerTables(connectorId, containerId) {
  return request(`/api/connectors/${connectorId}/containers/${containerId}/tables`);
}

export function fetchLocalFiles(connectorId) {
  return request(`/api/connectors/${connectorId}/local/tables`);
}

export async function uploadLocalFile(connectorId, file, displayName) {
  const formData = new FormData();
  formData.append('file', file);
  if (displayName) formData.append('display_name', displayName);

  const res = await fetch(`${API_BASE}/api/connectors/${connectorId}/local/upload`, {
    method: 'POST',
    body: formData, // no Content-Type header - browser sets the multipart boundary
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.details ? `${body.error}: ${body.details}` : (body.error || `Request failed: ${res.status}`);
    throw new Error(message);
  }
  return body;
}

export function deleteLocalFile(connectorId, tableId) {
  return request(`/api/connectors/${connectorId}/local/tables/${tableId}`, { method: 'DELETE' });
}

// --- Harvest ---

export function runHarvest({ connectorId, mode, items }) {
  return request('/api/harvest', {
    method: 'POST',
    body: JSON.stringify({ connector_id: connectorId, mode, items }),
  });
}

// --- Catalog ---

export function fetchCatalog({ search, type, connectorType } = {}) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (connectorType) params.set('connector_type', connectorType);
  const qs = params.toString();
  return request(`/api/catalog${qs ? `?${qs}` : ''}`);
}

export function fetchCatalogAsset(id) {
  return request(`/api/catalog/${encodeURIComponent(id)}`);
}

// --- S2D: Source-to-Destination validation ---

export function fetchS2DMappings() {
  return request('/api/s2d/mappings');
}

export function createS2DMapping(payload) {
  return request('/api/s2d/mappings', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deleteS2DMapping(id) {
  return request(`/api/s2d/mappings/${id}`, { method: 'DELETE' });
}

export function fetchS2DTestCases(mappingId) {
  return request(`/api/s2d/mappings/${mappingId}/test-cases`);
}

export function createS2DTestCase(mappingId, payload) {
  return request(`/api/s2d/mappings/${mappingId}/test-cases`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateS2DTestCase(testCaseId, payload) {
  return request(`/api/s2d/test-cases/${testCaseId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteS2DTestCase(id) {
  return request(`/api/s2d/test-cases/${id}`, { method: 'DELETE' });
}

export function runSingleS2DTestCase(testCaseId) {
  return request(`/api/s2d/test-cases/${testCaseId}/run`, { method: 'POST' });
}

export function runS2DPipeline(mappingId) {
  return request(`/api/s2d/mappings/${mappingId}/run`, { method: 'POST' });
}

export function fetchS2DRun(runId) {
  return request(`/api/s2d/runs/${runId}`);
}

export function fetchS2DRuns(mappingId) {
  const qs = mappingId ? `?mapping_id=${mappingId}` : '';
  return request(`/api/s2d/runs${qs}`);
}

export function generateAITestCase({ tables, sourceTables, destinationTables, checkScope, description }) {
  return request('/api/s2d/ai/generate-test-case', {
    method: 'POST',
    body: JSON.stringify({
      check_scope: checkScope, tables,
      source_tables: sourceTables, destination_tables: destinationTables,
      description,
    }),
  });
}

export function generateKeyColumnSuggestion({ sourceTables, destinationTables, description }) {
  return request('/api/s2d/ai/generate-test-case', {
    method: 'POST',
    body: JSON.stringify({
      check_scope: 'cross_table_parity',
      source_tables: sourceTables, destination_tables: destinationTables,
      description,
    }),
  });
}

export function generateAISuggestedRules(mappingId, { target, tableName }) {
  return request(`/api/s2d/mappings/${mappingId}/ai/suggest-rules`, {
    method: 'POST',
    body: JSON.stringify({ target, table_name: tableName }),
  });
}

export function generateAISuggestedParityRules(mappingId, { sourceTables, destinationTables }) {
  return request(`/api/s2d/mappings/${mappingId}/ai/suggest-parity-rules`, {
    method: 'POST',
    body: JSON.stringify({ source_tables: sourceTables, destination_tables: destinationTables }),
  });
}

export function setS2DTestCaseActive(id, active) {
  return request(`/api/s2d/test-cases/${id}/active`, {
    method: 'PATCH',
    body: JSON.stringify({ active }),
  });
}