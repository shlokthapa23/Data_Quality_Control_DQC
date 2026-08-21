import { useState } from 'react';
import { User, Mail, Building2, ShieldCheck, Calendar, KeyRound, Trash2, LogOut } from 'lucide-react';

// Every action on this page is deliberately inert - the user asked for the
// page and its layout now, not working account-mutation endpoints yet. Each
// button just surfaces this note instead of doing nothing silently, the same
// way this codebase already tells testers plainly when something "isn't
// wired up yet" (e.g. PySpark execution) rather than letting a click look
// broken. Including Log Out here, even though a real one already exists in
// the sidebar - this page's own copy stays inert so it doesn't behave
// differently from its neighbours.
const ACTIONS = [
  {
    key: 'password',
    icon: KeyRound,
    label: 'Change Password',
    desc: 'Update the password used to sign in.',
    tone: 'default',
  },
  {
    key: 'logout',
    icon: LogOut,
    label: 'Log Out',
    desc: 'End this session on this device.',
    tone: 'default',
  },
  {
    key: 'delete',
    icon: Trash2,
    label: 'Delete Account',
    desc: 'Permanently remove this account and its organization.',
    tone: 'danger',
  },
];

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return iso;
  }
}

export default function ProfilePage({ user }) {
  const [pendingKey, setPendingKey] = useState(null);

  if (!user) {
    return <div className="text-sm text-slate-500">No account information available.</div>;
  }

  const initial = (user.full_name || user.email || '?').charAt(0).toUpperCase();

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Your Profile</h1>
      <p className="text-sm text-slate-500 mb-6">Account details for this Data Quality Control login.</p>

      <div className="bg-white border border-slate-200 rounded-xl p-6 mb-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-mastek-primary/10 text-mastek-primary font-bold text-xl">
            {initial}
          </div>
          <div className="min-w-0">
            <p className="font-bold text-slate-900 truncate">{user.full_name}</p>
            <p className="text-sm text-slate-500 truncate">{user.email}</p>
          </div>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div className="flex items-start gap-2">
            <Mail className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
            <div>
              <dt className="text-slate-400 text-xs">Email</dt>
              <dd className="text-slate-900">{user.email}</dd>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Building2 className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
            <div>
              <dt className="text-slate-400 text-xs">Organization</dt>
              <dd className="text-slate-900">{user.organization_name}</dd>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
            <div>
              <dt className="text-slate-400 text-xs">Role</dt>
              <dd className="text-slate-900 capitalize">{user.role}</dd>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Calendar className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
            <div>
              <dt className="text-slate-400 text-xs">Member since</dt>
              <dd className="text-slate-900">{formatDate(user.created_at)}</dd>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <User className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
            <div>
              <dt className="text-slate-400 text-xs">Account ID</dt>
              <dd className="text-slate-900 font-mono text-xs">{user.id}</dd>
            </div>
          </div>
        </dl>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="font-bold text-slate-900 mb-1">Manage account</h2>
        <p className="text-xs text-slate-400 mb-4">
          These actions are not implemented yet - a placeholder for what's coming.
        </p>

        <div className="space-y-3">
          {ACTIONS.map(({ key, icon: Icon, label, desc, tone }) => (
            <div key={key}>
              <button
                type="button"
                onClick={() => setPendingKey(key)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-colors ${
                  tone === 'danger'
                    ? 'border-red-200 hover:bg-red-50 text-red-700'
                    : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${tone === 'danger' ? 'text-red-500' : 'text-slate-400'}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className={`text-xs ${tone === 'danger' ? 'text-red-500' : 'text-slate-400'}`}>{desc}</p>
                </div>
              </button>
              {pendingKey === key && (
                <p className="mt-1.5 px-1 text-xs text-slate-400 italic">
                  This isn't wired up yet - no changes were made.
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
