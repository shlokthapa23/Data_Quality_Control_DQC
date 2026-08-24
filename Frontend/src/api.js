const API_BASE = 'http://127.0.0.1:5000';

function authHeaders() {
  const token = localStorage.getItem('access_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// A 401 means the token is missing/expired/invalid - every route but /api/auth/*
// and /api/health requires one (see app.py's before_request gate). Clearing and
// reloading is the simplest reliable way back to the login screen from any call
// site, without threading auth state through every page that calls the API.
function handleUnauthorized(res) {
  if (res.status === 401) {
    localStorage.removeItem('access_token');
    window.location.reload();
    return true;
  }
  return false;
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...options,
  });
  if (handleUnauthorized(res)) throw new Error('Session expired');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.details ? `${body.error}: ${body.details}` : (body.error || `Request failed: ${res.status}`);
    throw new Error(message);
  }
  return body;
}

// --- Auth ---

export function login({ email, password }) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register({ email, password, full_name, organization_name }) {
  return request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, full_name, organization_name }),
  });
}

export function fetchCurrentUser() {
  return request('/api/auth/me');
}

export function logout() {
  localStorage.removeItem('access_token');
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

export async function deleteConnector(id, { force = false } = {}) {
  const res = await fetch(`${API_BASE}/api/connectors/${id}${force ? '?force=1' : ''}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  });
  if (handleUnauthorized(res)) throw new Error('Session expired');
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && body.requires_force) {
    // Not a failure - the server is asking whether the tester means it.
    const err = new Error(body.error);
    err.requiresForce = true;
    err.dependents = body.dependents || [];
    err.testCaseCount = body.test_case_count || 0;
    throw err;
  }
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
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

// includeRowCounts adds a row_count to every table so pickers can show how big
// it is. Opt-in because counting costs time against a remote endpoint - callers
// that only need columns (the column map editor, template dropdowns) omit it.
// harvestedOnly narrows the list to tables that came back the last harvest of
// this connector+container, and the response gains a `harvested` flag - only
// Test Data Preparation's picker uses this; everything else keeps seeing every
// live table.
export function fetchContainerTables(connectorId, containerId, { includeRowCounts = false, harvestedOnly = false } = {}) {
  const params = new URLSearchParams();
  if (includeRowCounts) params.set('include_row_counts', '1');
  if (harvestedOnly) params.set('harvested_only', '1');
  const query = params.toString() ? `?${params}` : '';
  return request(`/api/connectors/${connectorId}/containers/${containerId}/tables${query}`);
}

// Pure local-DB read (no live connector call) - which table names came back
// the last time this connector+container was harvested. Lets a caller that
// already has a full live table list (e.g. Test Data Preparation, which needs
// every table for its before/after run diff) filter what it displays without
// paying for a second live fetch just to do it.
export function fetchHarvestedTableNames(connectorId, containerId) {
  return request(`/api/connectors/${connectorId}/containers/${containerId}/harvested-tables`);
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
    headers: authHeaders(), // no Content-Type - browser sets the multipart boundary
    body: formData,
  });
  if (handleUnauthorized(res)) throw new Error('Session expired');
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

// Rebuild an XML table from a different repeating element. The raw upload is
// still on disk, so correcting a bad guess costs no re-upload.
export function reingestLocalTable(connectorId, tableId, xmlRecordElement) {
  return request(`/api/connectors/${connectorId}/local/tables/${tableId}/reingest`, {
    method: 'POST',
    body: JSON.stringify({ xml_record_element: xmlRecordElement }),
  });
}

// --- Data pipelines (fabric connectors only) ---

export function fetchPipelines(connectorId) {
  return request(`/api/connectors/${connectorId}/pipelines`);
}

export function runPipeline(connectorId, itemId) {
  return request(`/api/connectors/${connectorId}/pipelines/${itemId}/run`, { method: 'POST' });
}

export function fetchPipelineRuns(connectorId, itemId) {
  return request(`/api/connectors/${connectorId}/pipelines/${itemId}/runs`);
}

export function fetchPipelineRun(connectorId, itemId, runId) {
  return request(`/api/connectors/${connectorId}/pipelines/${itemId}/runs/${runId}`);
}

// Pipeline schedules. Note the path: /api/connectors/:id/schedules is already
// the harvest schedule list, so these live under their own segment.
export function fetchPipelineSchedules(connectorId, pipelineItemId) {
  const query = pipelineItemId ? `?pipeline_item_id=${encodeURIComponent(pipelineItemId)}` : '';
  return request(`/api/connectors/${connectorId}/pipeline-schedules${query}`);
}

export function createPipelineSchedule(connectorId, payload) {
  return request(`/api/connectors/${connectorId}/pipeline-schedules`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updatePipelineSchedule(scheduleId, payload) {
  return request(`/api/pipelines/schedules/${scheduleId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function deletePipelineSchedule(scheduleId) {
  return request(`/api/pipelines/schedules/${scheduleId}`, { method: 'DELETE' });
}

export function fetchPipelineScheduleEvents(scheduleId, limit = 20) {
  return request(`/api/pipelines/schedules/${scheduleId}/events?limit=${limit}`);
}

// --- Harvest ---

export function runHarvest({ connectorId, mode, items }) {
  return request('/api/harvest', {
    method: 'POST',
    body: JSON.stringify({ connector_id: connectorId, mode, items }),
  });
}

// --- Catalog ---

export function fetchCatalog({ search, type, connectorId, connectorType } = {}) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (connectorId) params.set('connector_id', connectorId);
  if (connectorType) params.set('connector_type', connectorType);
  const qs = params.toString();
  return request(`/api/catalog${qs ? `?${qs}` : ''}`);
}

export function fetchCatalogAsset(id) {
  return request(`/api/catalog/${encodeURIComponent(id)}`);
}

// Removes the harvested-metadata record only - never the real Lakehouse,
// table, or file it describes. No dependents/force flow (unlike deleteConnector):
// nothing in this app references a catalog row by id, only by connector+container.
export function deleteCatalogAsset(id) {
  return request(`/api/catalog/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Same metadata-only guarantee, batched - the Catalog Viewer's multi-select delete.
export function deleteCatalogAssets(ids) {
  return request('/api/catalog', { method: 'DELETE', body: JSON.stringify({ ids }) });
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

export function renameS2DMapping(id, name) {
  return request(`/api/s2d/mappings/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

// Name, the tables each side covers, and/or (via source_endpoint/
// destination_endpoint) which Lakehouse a side points at. Send only what
// changed; tables are a full replace for that side, never a delta.
//
// Changing a side's endpoint deletes this layer's test cases (their SQL/rules
// were written against the OLD Lakehouse), so the same not-a-failure 409 flow
// as deleteConnector's force-delete applies: a first attempt without
// confirm_delete_test_cases gets a 409 naming the exact count, and the caller
// resends with confirm_delete_test_cases: true once the tester has seen it.
export async function updateS2DMapping(id, patch) {
  const res = await fetch(`${API_BASE}/api/s2d/mappings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (handleUnauthorized(res)) throw new Error('Session expired');
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && body.requires_confirm) {
    const err = new Error(body.error);
    err.requiresConfirm = true;
    err.testCaseCount = body.test_case_count || 0;
    throw err;
  }
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

export function deleteS2DMapping(id) {
  return request(`/api/s2d/mappings/${id}`, { method: 'DELETE' });
}

// Parses + binds the script on that side's real connector without executing it.
// Resolves to { ok, error } for BOTH outcomes - a syntax error is a valid
// result, not a request failure - so callers read `ok` rather than catching.
export function validateS2DSql(mappingId, { target, sql }) {
  return request(`/api/s2d/mappings/${mappingId}/validate-sql`, {
    method: 'POST',
    body: JSON.stringify({ target, sql }),
  });
}

// Dashboard aggregates. mappingIds empty = every layer, including runs whose
// layer was later deleted; basis 'latest' = each layer's most recent run only.
export function fetchS2DAnalytics({ mappingIds = [], basis = 'latest', range = 'all' } = {}) {
  const params = new URLSearchParams({ basis, range });
  if (mappingIds.length) params.set('mapping_ids', mappingIds.join(','));
  return request(`/api/s2d/analytics?${params}`);
}

// Returns { blob, filename } - the server names the file, so the name matches
// the scope and stamp recorded inside the document itself.
export async function exportS2DAnalytics(payload) {
  const res = await fetch(`${API_BASE}/api/s2d/analytics/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (handleUnauthorized(res)) throw new Error('Session expired');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.details ? `${body.error}: ${body.details}` : (body.error || `Export failed: ${res.status}`));
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  return { blob: await res.blob(), filename: match ? match[1] : 'data-quality-export' };
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

// --- S2D: Test suites ---

export function fetchTestSuites() {
  return request('/api/s2d/suites');
}

export function fetchTestSuitesForMapping(mappingId) {
  return request(`/api/s2d/mappings/${mappingId}/suites`);
}

export function fetchTestSuite(suiteId) {
  return request(`/api/s2d/suites/${suiteId}`);
}

export function createTestSuite(mappingId, payload) {
  return request(`/api/s2d/mappings/${mappingId}/suites`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateTestSuite(suiteId, payload) {
  return request(`/api/s2d/suites/${suiteId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function deleteTestSuite(suiteId) {
  return request(`/api/s2d/suites/${suiteId}`, { method: 'DELETE' });
}

export function runTestSuite(suiteId) {
  return request(`/api/s2d/suites/${suiteId}/run`, { method: 'POST' });
}

// --- Schedules ---

export function fetchAllSchedules() {
  return request('/api/schedules');
}

export function previewSchedule(payload) {
  return request('/api/schedules/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchSuiteSchedules(suiteId) {
  return request(`/api/s2d/suites/${suiteId}/schedules`);
}

export function createSuiteSchedule(suiteId, payload) {
  return request(`/api/s2d/suites/${suiteId}/schedules`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateSuiteSchedule(scheduleId, payload) {
  return request(`/api/s2d/schedules/${scheduleId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function deleteSuiteSchedule(scheduleId) {
  return request(`/api/s2d/schedules/${scheduleId}`, { method: 'DELETE' });
}

export function fetchSuiteScheduleEvents(scheduleId, limit = 20) {
  return request(`/api/s2d/schedules/${scheduleId}/events?limit=${limit}`);
}

export function fetchHarvestSchedules(connectorId) {
  return request(`/api/connectors/${connectorId}/schedules`);
}

export function createHarvestSchedule(connectorId, payload) {
  return request(`/api/connectors/${connectorId}/schedules`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateHarvestSchedule(scheduleId, payload) {
  return request(`/api/harvest/schedules/${scheduleId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function deleteHarvestSchedule(scheduleId) {
  return request(`/api/harvest/schedules/${scheduleId}`, { method: 'DELETE' });
}

export function fetchHarvestScheduleEvents(scheduleId, limit = 20) {
  return request(`/api/harvest/schedules/${scheduleId}/events?limit=${limit}`);
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

export function generateAISuggestedCrossTableParityRules(mappingId, { sourceTables, destinationTables }) {
  return request(`/api/s2d/mappings/${mappingId}/ai/suggest-cross-table-parity-rules`, {
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