import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('published ESM, CommonJS and browser declarations infer bank-specific results', () => {
  // Keep consumers inside the package scope so TypeScript resolves the real exports map.
  const folder = mkdtempSync(fileURLToPath(new URL('./.type-consumer-', import.meta.url)));
  try {
    const shared = `
      import { parse, parseAsync, type ParseResult, type StatementFor } from '@ahdeyy/statement-kit';
      const bytes = new Uint8Array();
      const { data, error } = parse('Guaranty-Trust Bank', bytes);
      if (!error) {
        const bank: 'gtbank' = data.bank;
        const balance: number = data.transactions[0].balance;
        const reference: string | undefined = data.transactions[0].reference;
        const statement: StatementFor<'gtbank'> = data;
        const jsonBalance: number = statement.toJSON().transactions[0].balance;
      }
      const result = parse('auto', bytes);
      if (!result.error && result.data.bank === 'uba') {
        const balance: number = result.data.transactions[0].balance;
        // @ts-expect-error UBA does not emit references.
        result.data.transactions[0].reference;
      }
      const promise: Promise<ParseResult<'cowrywise'>> = parseAsync('COWRYWISE', bytes);
      async function checkAsync() {
        const result = await promise;
        if (!result.error) {
          const balance: number = result.data.toJSON().transactions[0].balance;
          // @ts-expect-error Cowrywise does not return a separate fee field.
          result.data.transactions[0].fee;
        }
      }
    `;
    const browser = `
      import { parseAsync as parseBrowser, type ParseResult as BrowserResult } from '@ahdeyy/statement-kit/browser';
      const browserPromise: Promise<BrowserResult<'zenith'>> = parseBrowser('Zenith-Bank', bytes);
      async function checkBrowser() {
        const { data, error } = await browserPromise;
        if (!error) {
          const balance: number = data.transactions[0].balance;
          // @ts-expect-error Zenith does not emit references.
          data.transactions[0].reference;
        }
      }
    `;
    const esm = join(folder, 'consumer.mts');
    const cjs = join(folder, 'consumer.cts');
    writeFileSync(esm, shared + browser);
    writeFileSync(cjs, shared);
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const run = spawnSync(process.execPath, [
      tsc, '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext', esm, cjs,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(run.error).toBeUndefined();
    expect(run.stdout + run.stderr).toBe('');
    expect(run.status).toBe(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 30_000);
