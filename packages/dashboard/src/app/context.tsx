import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import type { DashboardBootstrap } from '../client/dashboard-client';
import { DashboardClient, readBootstrap } from '../client/dashboard-client';

export interface DashboardApi {
  client: DashboardClient;
  bootstrap: DashboardBootstrap;
}

const DashboardContext = createContext<DashboardApi | null>(null);

/**
 * Provides the API client + injected bootstrap to the tree. Tests supply a fake `client`/`bootstrap`;
 * production defaults to a real {@link DashboardClient} reading the provider-injected globals.
 */
export function DashboardProvider({
  value,
  children,
}: {
  value?: Partial<DashboardApi>;
  children: ReactNode;
}) {
  const bootstrap = value?.bootstrap ?? readBootstrap();
  const client = value?.client ?? new DashboardClient({ apiBase: bootstrap.apiBase });
  return (
    <DashboardContext.Provider value={{ client, bootstrap }}>{children}</DashboardContext.Provider>
  );
}

export function useDashboard(): DashboardApi {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within a DashboardProvider');
  return ctx;
}
