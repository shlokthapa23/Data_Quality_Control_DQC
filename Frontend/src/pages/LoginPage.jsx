import { useState } from 'react';
import {
  ShieldCheck, ArrowRight, Layers, Zap, Share2, BarChart2, TrendingUp,
  Eye, EyeOff, Mail, Lock, AlertCircle,
} from 'lucide-react';
import { login, register, fetchCurrentUser } from '../api';
import loginIllustration from '../images/Login_page.png';

// ── "Remember me" persistence ───────────────────────────────────────────────
// Stored in localStorage so it survives browser/frontend/backend restarts.
// NOTE: this keeps the password on the device (lightly obfuscated, not
// encrypted) for convenience - only enable on a trusted machine.
const REMEMBER_KEY = 'fep_remembered_login';

function encode(s) {
  try { return btoa(unescape(encodeURIComponent(s))); } catch { return ''; }
}
function decode(s) {
  try { return decodeURIComponent(escape(atob(s))); } catch { return ''; }
}
function readRemembered() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { email: parsed.email || '', password: parsed.password ? decode(parsed.password) : '' };
  } catch {
    return null;
  }
}

const FEATURES = [
  {
    icon: Share2,
    title: 'Fabric Connectivity',
    desc: 'Connect Lakehouses and local files, then validate them side by side.',
  },
  {
    icon: BarChart2,
    title: 'Data Quality Dashboard',
    desc: 'Pass rates and row-level quality, rolled up across every test layer.',
  },
  {
    icon: ShieldCheck,
    title: 'Source-to-Destination Checks',
    desc: 'Row counts, column parity, and custom SQL prove data arrived intact.',
  },
  {
    icon: TrendingUp,
    title: 'Scheduled Validation',
    desc: 'Suites, harvests, and pipelines run on their own, with full history.',
  },
];

const STATS = [
  { value: '2', label: 'Connector Types', icon: Layers },
  { value: '8', label: 'Parity Metrics', icon: ShieldCheck },
  { value: '24/7', label: 'Scheduled Runs', icon: Zap },
];

export default function LoginPage({ onLogin }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loginEmail, setLoginEmail] = useState(() => readRemembered()?.email ?? '');
  const [loginPassword, setLoginPassword] = useState(() => readRemembered()?.password ?? '');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regName, setRegName] = useState('');
  const [regOrg, setRegOrg] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => readRemembered() !== null);
  const [activeTab, setActiveTab] = useState('login');

  const completeLogin = async (accessToken) => {
    localStorage.setItem('access_token', accessToken);
    const user = await fetchCurrentUser();
    onLogin(user);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { access_token } = await login({ email: loginEmail, password: loginPassword });
      if (rememberMe) {
        localStorage.setItem(
          REMEMBER_KEY,
          JSON.stringify({ email: loginEmail, password: encode(loginPassword) }),
        );
      } else {
        localStorage.removeItem(REMEMBER_KEY);
      }
      await completeLogin(access_token);
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { access_token } = await register({
        email: regEmail, password: regPassword, full_name: regName, organization_name: regOrg,
      });
      await completeLogin(access_token);
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 font-sans text-slate-900">

      {/* ── LEFT PANEL ── */}
      <div
        className="hidden lg:flex lg:w-[55%] flex-col h-full bg-white relative overflow-hidden"
        style={{ borderRight: '1px solid #e2e8f0' }}
      >
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage: 'radial-gradient(circle, var(--color-mastek-primary) 1.5px, transparent 1.5px)',
            backgroundSize: '28px 28px',
          }}
        />

        <div className="relative z-10 flex flex-col h-full px-10 py-8">

          <div className="shrink-0 flex flex-col items-center text-center">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-2xl mb-3"
              style={{
                background: 'linear-gradient(135deg, var(--color-mastek-primary), var(--color-mastek-secondary))',
                boxShadow: '0 8px 20px -6px rgba(0, 22, 137, 0.35)',
              }}
            >
              <ShieldCheck className="h-7 w-7 text-white" strokeWidth={2.25} />
            </div>
            <div className="font-bold tracking-tight leading-none text-mastek-primary" style={{ fontSize: '1.7rem' }}>
              Data Quality Control
            </div>
            <div className="flex items-center gap-2 mt-3">
              <div className="h-px w-10" style={{ background: 'var(--color-mastek-accent)' }} />
              <span className="text-mastek-secondary" style={{ fontSize: '11px', fontWeight: 500, letterSpacing: '0.06em' }}>
                Connect. Validate. Trust your data.
              </span>
              <div className="h-px w-10" style={{ background: 'var(--color-mastek-accent)' }} />
            </div>
          </div>

          <div className="flex items-center flex-1 gap-2 my-5 min-h-0">
            <div className="flex-1 flex flex-col justify-center">
              <h1 className="text-[2.5rem] font-black leading-[1.18] mb-3 text-mastek-primary">
                Trust Value Velocity
              </h1>
              <p className="text-sm leading-relaxed max-w-xs mb-5 text-slate-500">
                Source-to-destination validation for Microsoft Fabric - full
                visibility into what arrived, what changed, and what to fix.
              </p>

              <div className="grid grid-cols-1 gap-3">
                {FEATURES.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-mastek-primary/10 border border-mastek-primary/20">
                      <Icon className="h-4 w-4 text-mastek-primary" />
                    </div>
                    <div>
                      <p className="font-bold text-xs text-slate-900">{title}</p>
                      <p className="text-xs mt-0.5 leading-relaxed text-slate-500">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="shrink-0 flex items-center justify-center" style={{ width: 270 }}>
              <img src={loginIllustration} alt="" className="max-w-full max-h-full object-contain" />
            </div>
          </div>

          <div className="flex items-center shrink-0 mb-4 rounded-xl overflow-hidden border border-slate-200 bg-slate-50">
            {STATS.map(({ value, label, icon: StatIcon }, i) => (
              <div
                key={label}
                className="flex-1 flex flex-col items-center py-3 gap-1"
                style={{ borderRight: i < STATS.length - 1 ? '1px solid #E2E8F0' : undefined }}
              >
                <div className="flex items-center gap-1.5">
                  <StatIcon className="h-3.5 w-3.5 text-mastek-primary" />
                  <span className="font-black text-xl leading-none text-mastek-primary">{value}</span>
                </div>
                <span className="text-[11px] font-medium text-slate-500">{label}</span>
              </div>
            ))}
          </div>

          <p className="text-[11px] shrink-0 text-slate-800" align-center>
            © {new Date().getFullYear()} Mastek Ltd. All rights reserved.
          </p>
        </div>
      </div>

      {/* ── RIGHT PANEL ── */}
      <div className="flex flex-1 flex-col items-center justify-center bg-slate-50 px-8 lg:px-14 h-full overflow-y-auto">
        <div className="w-full max-w-sm">

          <div className="mb-6">
            <h2 className="text-3xl font-bold text-slate-900">
              {activeTab === 'login' ? 'Welcome back' : 'Get started'}
            </h2>
            <p className="text-slate-500 text-sm mt-1">
              {activeTab === 'login'
                ? 'Sign in to Data Quality Control'
                : 'Create your Data Quality Control account'}
            </p>
          </div>

          <div className="grid w-full grid-cols-2 h-10 mb-6 border-b border-slate-200">
            <button
              type="button"
              onClick={() => { setActiveTab('login'); setError(null); }}
              className={`h-full font-medium border-b-2 transition-colors ${
                activeTab === 'login'
                  ? 'border-mastek-primary text-mastek-primary'
                  : 'border-transparent text-slate-500'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab('register'); setError(null); }}
              className={`h-full font-medium border-b-2 transition-colors ${
                activeTab === 'register'
                  ? 'border-mastek-primary text-mastek-primary'
                  : 'border-transparent text-slate-500'
              }`}
            >
              Register
            </button>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {activeTab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="login-email" className="text-sm font-medium text-slate-700">Email address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                  <input
                    id="login-email"
                    type="email"
                    placeholder="you@company.com"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    className="h-10 w-full pl-9 pr-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-mastek-primary/30 focus:border-mastek-primary"
                    required
                    autoComplete="email"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="login-password" className="text-sm font-medium text-slate-700">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    className="h-10 w-full pl-9 pr-10 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-mastek-primary/30 focus:border-mastek-primary"
                    required
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-slate-500 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded border-slate-300"
                    style={{ accentColor: 'var(--color-mastek-primary)' }}
                  />
                  Remember me
                </label>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-10 rounded-lg font-semibold flex items-center justify-center gap-2 text-white bg-mastek-primary hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {loading ? 'Signing in…' : <><span>Sign In</span><ArrowRight className="h-4 w-4" /></>}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="reg-name" className="text-sm font-medium text-slate-700">Full Name</label>
                <input
                  id="reg-name"
                  placeholder="Jane Smith"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  className="h-10 w-full px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-mastek-primary/30 focus:border-mastek-primary"
                  required
                  autoComplete="name"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="reg-email" className="text-sm font-medium text-slate-700">Work Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                  <input
                    id="reg-email"
                    type="email"
                    placeholder="you@company.com"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    className="h-10 w-full pl-9 pr-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-mastek-primary/30 focus:border-mastek-primary"
                    required
                    autoComplete="email"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="reg-password" className="text-sm font-medium text-slate-700">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                  <input
                    id="reg-password"
                    type="password"
                    placeholder="Min. 8 characters"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    className="h-10 w-full pl-9 pr-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-mastek-primary/30 focus:border-mastek-primary"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="reg-org" className="text-sm font-medium text-slate-700">Organization</label>
                <input
                  id="reg-org"
                  placeholder="Your company name"
                  value={regOrg}
                  onChange={(e) => setRegOrg(e.target.value)}
                  className="h-10 w-full px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-mastek-primary/30 focus:border-mastek-primary"
                  required
                  autoComplete="organization"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full h-10 rounded-lg font-semibold flex items-center justify-center gap-2 text-white bg-mastek-primary hover:opacity-90 transition-opacity disabled:opacity-60 !mt-4"
              >
                {loading ? 'Creating account…' : <><span>Create Account</span><ArrowRight className="h-4 w-4" /></>}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
