import { useState } from 'react';
import { Plug, HardDrive, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { createConnector, testConnectorDraft } from '../../api';

const EMPTY_FABRIC_FORM = {
  name: '', tenant_id: '', client_id: '', client_secret: '', workspace_id: '',
};

export default function ConnectorForm({ onCreated }) {
  const [type, setType] = useState('fabric'); // 'fabric' | 'local'
  const [fabricForm, setFabricForm] = useState(EMPTY_FABRIC_FORM);
  const [localName, setLocalName] = useState('');

  const [testResult, setTestResult] = useState(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (field) => (e) => {
    setFabricForm((f) => ({ ...f, [field]: e.target.value }));
    setTestResult(null);
  };

  const isComplete = type === 'fabric'
    ? Object.values(fabricForm).every((v) => v.trim() !== '')
    : localName.trim() !== '';

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const payload = type === 'fabric' ? { type, ...fabricForm } : { type };
      const result = await testConnectorDraft(payload);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setIsTesting(false);
    }
  };

  const handleCreate = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const payload = type === 'fabric'
        ? { type, ...fabricForm }
        : { type, name: localName };
      await createConnector(payload);
      setFabricForm(EMPTY_FABRIC_FORM);
      setLocalName('');
      setTestResult(null);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 max-w-lg">
      <div className="bg-slate-100 p-1 rounded-lg flex gap-1 text-sm font-medium mb-5 w-fit">
        <button
          onClick={() => { setType('fabric'); setTestResult(null); }}
          className={`px-4 py-1.5 rounded-md flex items-center gap-1.5 transition-colors ${
            type === 'fabric' ? 'bg-white shadow text-mastek-primary' : 'text-slate-500'
          }`}
        >
          <Plug className="w-3.5 h-3.5" /> Microsoft Fabric
        </button>
        <button
          onClick={() => { setType('local'); setTestResult(null); }}
          className={`px-4 py-1.5 rounded-md flex items-center gap-1.5 transition-colors ${
            type === 'local' ? 'bg-white shadow text-mastek-primary' : 'text-slate-500'
          }`}
        >
          <HardDrive className="w-3.5 h-3.5" /> Local Files
        </button>
      </div>

      {type === 'fabric' && (
        <div className="space-y-3">
          <Field label="Connector Name" value={fabricForm.name} onChange={update('name')} placeholder="My Fabric Workspace" />
          <Field label="Tenant ID" value={fabricForm.tenant_id} onChange={update('tenant_id')} type="password" />
          <Field label="Client ID" value={fabricForm.client_id} onChange={update('client_id')} type="password" />
          <Field label="Client Secret" value={fabricForm.client_secret} onChange={update('client_secret')} type="password" />
          <Field label="Workspace ID" value={fabricForm.workspace_id} onChange={update('workspace_id')} type="password" />
        </div>
      )}

      {type === 'local' && (
        <div className="space-y-3">
          <Field label="Connector Name" value={localName} onChange={(e) => { setLocalName(e.target.value); setTestResult(null); }} placeholder="My Local Files" />
          <p className="text-xs text-slate-400">
            No credentials needed - you'll upload CSV/Parquet files directly after creating this.
          </p>
        </div>
      )}

      {testResult && (
        <div className={`mt-4 flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
          testResult.ok ? 'bg-mastek-success/10 text-mastek-success' : 'bg-red-50 text-red-600'
        }`}>
          {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
          <span>{testResult.message}</span>
        </div>
      )}

      {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

      <div className="mt-5 flex gap-3">
        <button
          onClick={handleTest}
          disabled={!isComplete || isTesting}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isTesting && <Loader2 className="w-4 h-4 animate-spin" />}
          Test Connection
        </button>
        <button
          onClick={handleCreate}
          disabled={!isComplete || isSaving}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-mastek-primary rounded-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          Create
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-500 mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mastek-accent focus:border-transparent"
      />
    </label>
  );
}