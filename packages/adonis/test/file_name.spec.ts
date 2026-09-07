import { describe, expect, it } from 'vitest';
import { UnsafeFileNameError } from '../src/errors.js';
import { sanitizeFileName } from '../src/file_name.js';

describe('sanitizeFileName', () => {
  it('passes ordinary file names through unchanged', () => {
    expect(sanitizeFileName('photo.png')).toBe('photo.png');
    expect(sanitizeFileName('Report Final (v2).pdf')).toBe('Report Final (v2).pdf');
    expect(sanitizeFileName('日本語ファイル.txt')).toBe('日本語ファイル.txt');
  });

  it('normalizes backslashes to forward slashes before validating', () => {
    // Not a valid outcome either — a backslash-separated traversal is still rejected — but this
    // proves the check does not miss it just because the separator is `\` instead of `/`.
    expect(() => sanitizeFileName('..\\..\\etc\\passwd')).toThrow(UnsafeFileNameError);
  });

  it('rejects path traversal', () => {
    expect(() => sanitizeFileName('../../etc/passwd')).toThrow(UnsafeFileNameError);
    expect(() => sanitizeFileName('a/../../b')).toThrow(UnsafeFileNameError);
  });

  it('rejects absolute paths', () => {
    expect(() => sanitizeFileName('/etc/passwd')).toThrow(UnsafeFileNameError);
  });

  it('rejects any embedded directory separator, not just traversal-shaped ones', () => {
    expect(() => sanitizeFileName('sub/dir/file.txt')).toThrow(UnsafeFileNameError);
  });

  it('rejects empty, ".", and ".." outright', () => {
    expect(() => sanitizeFileName('')).toThrow(UnsafeFileNameError);
    expect(() => sanitizeFileName('.')).toThrow(UnsafeFileNameError);
    expect(() => sanitizeFileName('..')).toThrow(UnsafeFileNameError);
  });

  it('rejects control characters (e.g. an embedded null byte or newline)', () => {
    const nullByte = String.fromCharCode(0);
    expect(() => sanitizeFileName(`evil${nullByte}.png`)).toThrow(UnsafeFileNameError);
    expect(() => sanitizeFileName('evil\n.png')).toThrow(UnsafeFileNameError);
  });

  it('names the error after the offending code and echoes the original input', () => {
    try {
      sanitizeFileName('../../etc/passwd');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeFileNameError);
      const err = error as UnsafeFileNameError;
      expect(err.code).toBe('E_MEDIA_UNSAFE_FILE_NAME');
      expect(err.fileName).toBe('../../etc/passwd');
    }
  });
});
