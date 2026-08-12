// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthScreen } from './AuthScreen';
import { renderView } from './testkit';

describe('AuthScreen', () => {
  it('submits credentials to the built-in login', async () => {
    const login = vi.fn(async () => {});
    renderView(<AuthScreen modes={['login']} />, { login });

    fireEvent.change(screen.getByLabelText('email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('ada@example.com', 'secret'));
  });

  it('shows an error on invalid credentials without crashing', async () => {
    const login = vi.fn(async () => {
      throw new Error('nope');
    });
    renderView(<AuthScreen modes={['login']} />, { login });

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Invalid credentials.'));
  });

  it('tells a session-only host to sign in there instead of rendering a form', () => {
    renderView(<AuthScreen modes={['session']} />, {});
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText(/gated by the host application/)).toBeTruthy();
  });
});
