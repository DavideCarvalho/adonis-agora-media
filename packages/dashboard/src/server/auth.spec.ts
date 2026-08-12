import { describe, expect, it } from 'vitest';
import { resolveConsoleAuth, signSessionCookie, verifySessionCookie } from './auth.js';

describe('signSessionCookie / verifySessionCookie', () => {
  it('round-trips a signed session', () => {
    const value = signSessionCookie(
      { id: 'u1', name: 'Ada', roles: ['admin'] },
      { secret: 'shh', ttlMs: 60_000, now: 1000 },
    );
    const session = verifySessionCookie(value, { secret: 'shh', now: 2000 });
    expect(session).toMatchObject({
      sub: 'u1',
      name: 'Ada',
      roles: ['admin'],
      iat: 1000,
      exp: 61000,
    });
  });

  it('defaults roles to an empty array and omits name when absent', () => {
    const value = signSessionCookie({ id: 'u2' }, { secret: 'shh', ttlMs: 1000, now: 0 });
    const session = verifySessionCookie(value, { secret: 'shh', now: 0 });
    expect(session).toMatchObject({ sub: 'u2', roles: [] });
    expect(session?.name).toBeUndefined();
  });

  it('rejects a cookie signed with a different secret', () => {
    const value = signSessionCookie({ id: 'u1' }, { secret: 'secret-a', ttlMs: 60_000, now: 0 });
    expect(verifySessionCookie(value, { secret: 'secret-b', now: 0 })).toBeNull();
  });

  it('rejects a tampered payload even with a valid-looking signature', () => {
    const value = signSessionCookie(
      { id: 'u1', roles: ['user'] },
      { secret: 'shh', ttlMs: 60_000, now: 0 },
    );
    const [payload, signature] = value.split('.');
    const forged = `${Buffer.from(JSON.stringify({ sub: 'admin', roles: ['admin'], iat: 0, exp: 60_000 })).toString('base64url')}.${signature}`;
    expect(payload).toBeDefined();
    expect(verifySessionCookie(forged, { secret: 'shh', now: 0 })).toBeNull();
  });

  it('rejects an expired session past the grace window', () => {
    const value = signSessionCookie({ id: 'u1' }, { secret: 'shh', ttlMs: 1000, now: 0 });
    expect(verifySessionCookie(value, { secret: 'shh', now: 1000 + 30_000 + 1 })).toBeNull();
  });

  it('accepts a session within the 30s expiry grace', () => {
    const value = signSessionCookie({ id: 'u1' }, { secret: 'shh', ttlMs: 1000, now: 0 });
    expect(verifySessionCookie(value, { secret: 'shh', now: 1000 + 29_000 })).not.toBeNull();
  });

  it('never throws on malformed input', () => {
    expect(verifySessionCookie('', { secret: 'shh' })).toBeNull();
    expect(verifySessionCookie('nodothere', { secret: 'shh' })).toBeNull();
    expect(verifySessionCookie('.nopayload', { secret: 'shh' })).toBeNull();
    expect(verifySessionCookie('not-base64!!!.sig', { secret: 'shh' })).toBeNull();
  });
});

describe('resolveConsoleAuth', () => {
  it('returns null when unconfigured (console stays open)', () => {
    expect(resolveConsoleAuth(undefined)).toBeNull();
  });

  it('throws when configured without a secret', () => {
    expect(() => resolveConsoleAuth({ secret: '', login: () => null })).toThrow(/secret/);
  });

  it('throws when configured without any hook', () => {
    expect(() => resolveConsoleAuth({ secret: 'shh' })).toThrow(/login.*session|session.*login/);
  });

  it('resolves modes from whichever hooks are present', () => {
    const loginOnly = resolveConsoleAuth({ secret: 'shh', login: () => null });
    expect(loginOnly?.modes).toEqual(['login']);

    const sessionOnly = resolveConsoleAuth({ secret: 'shh', session: () => null });
    expect(sessionOnly?.modes).toEqual(['session']);

    const both = resolveConsoleAuth({ secret: 'shh', login: () => null, session: () => null });
    expect(both?.modes).toEqual(['session', 'login']);
  });

  it('parses a duration string into milliseconds, defaulting to 8h on a bad value', () => {
    expect(resolveConsoleAuth({ secret: 'shh', login: () => null, ttl: '30m' })?.ttlMs).toBe(
      30 * 60 * 1000,
    );
    expect(resolveConsoleAuth({ secret: 'shh', login: () => null, ttl: 'nonsense' })?.ttlMs).toBe(
      8 * 60 * 60 * 1000,
    );
  });
});
