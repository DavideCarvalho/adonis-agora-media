import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'tempura';
import { describe, expect, it } from 'vitest';
import { configure } from '../configure.js';
import * as index from '../src/index.js';

const stubsDir = fileURLToPath(new URL('../stubs/', import.meta.url));

async function stubFiles(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of glob('**/*.stub', { cwd: stubsDir })) found.push(entry);
  return found.sort();
}

/**
 * `node ace configure` renders every stub through tempura, which treats a backtick as the start of
 * a JS template literal — including inside a comment. A stub that reads fine as TypeScript can
 * therefore fail to render, and nothing else in the build catches it: the stubs are data, never
 * compiled by tsc, and no unit test touched them. All three shipped broken through 0.3.0.
 */
describe('stubs', () => {
  it('renders every stub through the real compiler', async () => {
    const files = await stubFiles();
    expect(files.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of files) {
      const source = readFileSync(new URL(file, new URL('../stubs/', import.meta.url)), 'utf8');
      try {
        compile(source, { async: true });
      } catch (error) {
        failures.push(`${file}: ${(error as Error).message.split('\n')[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * `node ace configure <pkg>` reaches the hook through the package's main entry point, so a
   * configure.ts that exists but isn't re-exported from index leaves the command with nothing to
   * call. Shipped that way through 0.3.0.
   */
  it('re-exports the configure hook from the package index', () => {
    expect(index.configure).toBe(configure);
  });
});
