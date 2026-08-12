import { type FormEvent, useState } from 'react';
import { useLogin } from './queries';
import { Button } from './ui';

/** The media mark in the console accent, standalone (App's copy isn't exported to avoid a cycle).
 *  Ported verbatim from the NestJS sibling console's `AuthScreen.tsx`. */
function Mark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 text-accent"
      role="img"
      aria-label="media"
    >
      <title>media</title>
      <path d="M12 3 21 7.5 12 12 3 7.5z" opacity={0.9} />
      <path d="M3 12l9 4.5L21 12" opacity={0.55} />
      <path d="M3 16.5 12 21l9-4.5" opacity={0.3} />
    </svg>
  );
}

/**
 * The console's login gate, shown when `GET /me` reports the session is missing. Submits credentials
 * to the built-in `POST /login` route and, on success, invalidates every query so the app re-renders
 * into the console. Matches the NestJS sibling console's dark blueprint theme.
 */
export function AuthScreen({ modes }: { modes: string[] }) {
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const supportsLogin = modes.includes('login');

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await login.mutateAsync({ username, password });
    } catch {
      setError('Invalid credentials.');
    }
  }

  return (
    <>
      <div className="app-bg" />
      <div className="relative z-10 grid h-full place-items-center p-6">
        <div className="w-full max-w-sm rounded-lg border border-border bg-panel p-6 shadow-2xl">
          <div className="mb-5 flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-md border border-accent/30 bg-accent/10">
              <Mark />
            </div>
            <div className="leading-none">
              <div className="text-sm font-semibold tracking-tight">media</div>
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">agora</div>
            </div>
          </div>

          {supportsLogin ? (
            <form onSubmit={submit} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="mono text-[10px] uppercase tracking-wider text-zinc-600">
                  email
                </span>
                <input
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="mono rounded-md border border-border bg-black/30 px-3 py-2 text-sm text-zinc-100 focus:border-accent/40 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="mono text-[10px] uppercase tracking-wider text-zinc-600">
                  password
                </span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="mono rounded-md border border-border bg-black/30 px-3 py-2 text-sm text-zinc-100 focus:border-accent/40 focus:outline-none"
                />
              </label>
              {error && (
                <div role="alert" className="mono text-[11px] text-bad">
                  {error}
                </div>
              )}
              <Button
                type="submit"
                tone="accent"
                size="md"
                disabled={login.isPending}
                className="mt-1"
              >
                {login.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          ) : (
            <div className="mono text-xs text-zinc-500">
              This console is gated by the host application. Sign in there and reload.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
