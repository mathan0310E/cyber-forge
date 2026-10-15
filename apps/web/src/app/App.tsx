import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import type { ReactNode } from 'react';
import { LandingPage } from '../app/LandingPage';
import { LoginPage } from '../features/auth/LoginPage';
import { SignupPage } from '../features/auth/SignupPage';
import { ConnectIntegrationsPage } from '../features/integrations/ConnectIntegrations';
import { Dashboard } from '../features/dashboard/Dashboard';
import { NewProject } from '../features/dashboard/NewProject';
import { Workspace } from '../features/workspace/Workspace';
import { PublicLayout } from '../components/PublicLayout';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-forge-bg text-forge-muted">
        <span>Loading…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Onboarding() {
  const { user } = useAuth();
  return <Navigate to={user ? '/app' : '/'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<PublicLayout />}>
        <Route index element={<LandingPage />} />
        <Route path="features" element={<div className="p-8 text-forge-muted">Features — coming online.</div>} />
        <Route path="templates" element={<div className="p-8 text-forge-muted">Templates — coming online.</div>} />
        <Route path="docs" element={<div className="p-8 text-forge-muted">Docs — coming online.</div>} />
        <Route path="privacy" element={<div className="p-8 text-forge-muted">Privacy.</div>} />
        <Route path="terms" element={<div className="p-8 text-forge-muted">Terms.</div>} />
      </Route>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/app" element={<RequireAuth><Dashboard /></RequireAuth>} />
      <Route path="/app/connect" element={<RequireAuth><ConnectIntegrationsPage /></RequireAuth>} />
      <Route path="/app/new" element={<RequireAuth><NewProject /></RequireAuth>} />
      <Route path="/app/projects/:projectId" element={<RequireAuth><Workspace /></RequireAuth>} />
      <Route path="*" element={<Onboarding />} />
    </Routes>
  );
}