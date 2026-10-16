import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';

export function WolfMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#131923" />
      <path
        d="M8 24c1-7 4-12 8-15 4 3 7 8 8 15"
        fill="none"
        stroke="#D7F542"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M16 9c-2 2-3 4-3 6" fill="none" stroke="#19D3F3" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="8" r="1.6" fill="#FF8A24" />
    </svg>
  );
}

export function PublicLayout() {
  const { user, signOut } = useAuth();
  const navLink = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      isActive ? 'text-forge-lime' : 'text-forge-muted hover:text-forge-text'
    }`;

  return (
    <div className="flex min-h-screen flex-col bg-forge-bg">
      <header className="sticky top-0 z-40 border-b border-forge-border bg-forge-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-display text-lg font-bold tracking-tight">
            <WolfMark />
            <span>
              Wolf <span className="text-forge-orange">Forge</span>
            </span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="Primary">
            <NavLink to="/features" className={navLink}>
              Features
            </NavLink>
            <NavLink to="/templates" className={navLink}>
              Templates
            </NavLink>
            <NavLink to="/docs" className={navLink}>
              Docs
            </NavLink>
            {user ? (
              <div className="flex items-center gap-2">
                <Link to="/app" className="ml-2 rounded-md bg-forge-orange px-3 py-1.5 text-sm font-semibold text-forge-bg hover:brightness-95 hover:shadow-[0_0_16px_rgba(255,138,36,0.35)]">
                  Dashboard
                </Link>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="text-sm text-forge-muted hover:text-forge-text"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <NavLink to="/login" className={navLink}>
                  Log in
                </NavLink>
                <Link
                  to="/signup"
                  className="ml-2 rounded-md bg-forge-orange px-3 py-1.5 text-sm font-semibold text-forge-bg hover:brightness-95 hover:shadow-[0_0_16px_rgba(255,138,36,0.35)]"
                >
                  Get started
                </Link>
              </div>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-forge-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-forge-muted sm:flex-row">
          <div className="flex items-center gap-2">
            <WolfMark className="h-6 w-6" />
            <span>
              Wolf Forge · <span className="text-forge-text">Your Ideas. Our Forge.</span>
            </span>
          </div>
          <div className="flex gap-4">
            <Link to="/privacy" className="hover:text-forge-text">Privacy</Link>
            <Link to="/terms" className="hover:text-forge-text">Terms</Link>
            <Link to="/docs" className="hover:text-forge-text">Docs</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}