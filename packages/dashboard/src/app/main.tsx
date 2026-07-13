import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DashboardProvider } from './context';
import './styles.css';
import { ToastProvider } from './ui';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <DashboardProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </DashboardProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
