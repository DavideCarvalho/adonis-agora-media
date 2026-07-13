import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { DashboardBootstrap, DashboardClient } from '../client/dashboard-client';
import { DashboardProvider } from './context';
import { ToastProvider } from './ui';

const BOOTSTRAP: DashboardBootstrap = {
  apiBase: '/api',
  uploadsBase: '/media/uploads',
  tusBase: '/media/uploads/tus',
  actions: true,
};

/** Render a view wrapped in the real query/dashboard/toast providers with an injected fake client. */
export function renderView(
  ui: ReactElement,
  client: Partial<DashboardClient>,
  bootstrap: Partial<DashboardBootstrap> = {},
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        value={{ client: client as DashboardClient, bootstrap: { ...BOOTSTRAP, ...bootstrap } }}
      >
        <ToastProvider>{ui}</ToastProvider>
      </DashboardProvider>
    </QueryClientProvider>,
  );
}
