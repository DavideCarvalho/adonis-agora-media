import { describe, expect, it } from 'vitest';
import { isHeaderSafe, isMimeType, safeContentType } from '../src/http_safety.js';

describe('http_safety', () => {
  it('isMimeType accepts a bare type/subtype only', () => {
    expect(isMimeType('image/png')).toBe(true);
    expect(isMimeType('application/vnd.api+json')).toBe(true);
    expect(isMimeType('text/plain; charset=utf-8')).toBe(false);
    expect(isMimeType('image')).toBe(false);
    expect(isMimeType('image/png\u0000')).toBe(false);
    expect(isMimeType(42)).toBe(false);
  });

  it('safeContentType keeps a well-formed visible-ASCII value and falls back otherwise', () => {
    expect(safeContentType('image/png')).toBe('image/png');
    expect(safeContentType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(safeContentType('text/plain\r\nx-injected: 1')).toBe('application/octet-stream');
    expect(safeContentType('image/pngç')).toBe('application/octet-stream');
    expect(safeContentType('garbage')).toBe('application/octet-stream');
    expect(safeContentType(undefined)).toBe('application/octet-stream');
    expect(safeContentType(null, 'image/jpeg')).toBe('image/jpeg');
  });

  it('isHeaderSafe refuses control and non-latin characters', () => {
    expect(isHeaderSafe('Accept, Width')).toBe(true);
    expect(isHeaderSafe('a\nb')).toBe(false);
    expect(isHeaderSafe('ação')).toBe(false);
  });
});
