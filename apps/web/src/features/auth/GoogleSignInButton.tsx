import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

/**
 * "Continue with Google" button.
 *
 * The provided auth handles the Firebase sign-in popup and exchanges the ID
 * token for a Wolf Forge session. On success, the user lands on /app/connect,
 * which auto-checks GitHub + Vercel and starts any missing OAuth flow.
 * The popup is the standard Firebase Auth flow (unauthorized origin errors are
 * surfaced as a clear message).
 */
export function GoogleSignInButton() {
  const { googleSignIn, googleSignInAvailable } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!googleSignInAvailable) return null;

  const onClick = async () => {
    setBusy(true);
    setErr(null);
    try {
      const ran = await googleSignIn();
      if (ran) navigate('/app/connect', { replace: true });
    } catch (e) {
      setErr(
        e instanceof Error
          ? e.message
          : 'Google sign-in could not complete. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-forge-border bg-forge-surface px-4 py-2.5 text-sm font-medium text-forge-text hover:border-forge-border/60 hover:bg-forge-surface/60 disabled:opacity-50"
      >
        <GoogleG />
        {busy ? 'Connecting…' : 'Continue with Google'}
      </button>
      {err && (
        <p role="alert" className="mt-2 text-sm text-forge-orange">
          {err}
        </p>
      )}
    </div>
  );
}

function GoogleG() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.1h-1.6V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.4 6.4 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.4 6.4 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.6 16.3 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.7l6.2 5.2C41.8 35.5 44 30.2 44 24c0-1.3-.1-2.6-.4-3.9z"
      />
    </svg>
  );
}