import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { GoogleSignInButton } from './GoogleSignInButton';
import { WolfMark } from '../../components/PublicLayout';

export function SignupPage() {
  const { signUp, error, clearError } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (password.length < 8) {
      setFormError('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await signUp(email, password, displayName || undefined);
      navigate('/app');
    } catch {
      setFormError('Sign up failed. Try another email.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-forge-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <WolfMark className="h-10 w-10" />
          <span className="font-display text-2xl font-bold">
            Wolf <span className="text-forge-orange">Forge</span>
          </span>
        </div>
        <div className="rounded-2xl border border-forge-border bg-forge-panel p-6">
          <h1 className="font-display text-xl font-bold">Create your forge</h1>
          <p className="mt-1 text-sm text-forge-muted">Free to start. No AI credits required.</p>
          {(formError || error) && (
            <p role="alert" className="mt-3 rounded-md border border-forge-orange/40 bg-forge-orange/10 px-3 py-2 text-sm text-forge-orange">
              {formError ?? error}
            </p>
          )}
          <div className="mt-4">
            <GoogleSignInButton />
          </div>
          <div className="my-4 flex items-center gap-3 text-xs text-forge-muted">
            <span className="h-px flex-1 bg-forge-border" />
            or with email
            <span className="h-px flex-1 bg-forge-border" />
          </div>
          <form onSubmit={(e) => void submit(e)}>
          <label className="block text-sm font-medium" htmlFor="displayName">
            Display name <span className="text-forge-muted">(optional)</span>
          </label>
          <input
            id="displayName"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              clearError();
            }}
            className="mt-1 w-full rounded-lg border border-forge-border bg-forge-surface px-3 py-2 text-sm outline-none focus:border-forge-cyan"
          />
          <label className="mt-3 block text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              clearError();
            }}
            className="mt-1 w-full rounded-lg border border-forge-border bg-forge-surface px-3 py-2 text-sm outline-none focus:border-forge-cyan"
          />
          <label className="mt-3 block text-sm font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearError();
            }}
            className="mt-1 w-full rounded-lg border border-forge-border bg-forge-surface px-3 py-2 text-sm outline-none focus:border-forge-cyan"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-lg bg-forge-lime px-4 py-2.5 font-semibold text-forge-bg hover:brightness-95 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Get started'}
          </button>
        </form>
        </div>
        <p className="mt-4 text-center text-sm text-forge-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-forge-cyan hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}