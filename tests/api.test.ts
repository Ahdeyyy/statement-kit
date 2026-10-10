import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse, parseAsync, Statement, StatementFailure, StatementParseError, supportedBanks } from '../src/index.js';
import type { ParseResult, StatementSource } from '../src/index.js';
import { extractPdf } from '../src/pdf.js';
import { layouts, item, makePdf } from './fixtures/pdf.js';

const folder = mkdtempSync(join(tmpdir(), 'statement-kit-'));
const path = join(folder, 'statement with spaces.pdf');
writeFileSync(path, makePdf(layouts.gtbank));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function success(result: ParseResult): Statement {
  expect(result.error).toBeNull();
  if (result.error) throw result.error;
  expect(result.data).toBeInstanceOf(Statement);
  return result.data;
}

describe('public parser API', () => {
  test('synchronous parse returns class instances, not a promise', () => {
    const result = parse('GTBank', path);
    expect(result).not.toBeInstanceOf(Promise);
    const statement = success(result);
    expect(statement.transactions.map((row) => row.amount)).toEqual([-5000, 10000]);
    expect(statement.info.accountNumber).toBe('0123456789');
    expect(statement.info.openingBalance).toBe(100000);
    expect(statement.info.currency).toBe('NGN');
    expect(statement.transactions[0].reference).toBe('REF001');
    expect(statement.toCSV()).toContain('2026-02-01,POS PURCHASE,-5000.00,95000.00,REF001');
  });

  for (const bank of ['gtbank', 'zenith', 'uba', 'cowrywise'] as const) {
    test(`extracts a real synthetic ${bank} PDF`, async () => {
      const statement = success(await parseAsync(bank, makePdf(layouts[bank])));
      expect(statement.info.bank).toBe(bank);
      expect(statement.transactions.map((row) => row.amount)).toEqual(bank === 'cowrywise' ? [10000, -2000] : [-5000, 10000]);
      expect(statement.warnings).toEqual([]);
      expect(statement.transactions.map((row) => new Date(row.date).toISOString().slice(0, 10))).toEqual(['2026-02-01', '2026-02-02']);
      if (bank === 'cowrywise') {
        expect(statement.transactions[1].balance).toBe(7975);
        expect(statement.transactions[1].description).toBe('Withdrawal (fee 25.00)');
      }
      if (bank === 'zenith') expect(statement.transactions[0].description).toBe('POS PURCHASE WRAPPED DESCRIPTION');
      if (bank === 'uba') expect(statement.info.accountNumber).toBe('214xxxxx25');
    });
  }

  test('supports file URLs, paths, buffers, views and ArrayBuffers without mutating bytes', async () => {
    const bytes = makePdf(layouts.gtbank);
    const before = Buffer.from(bytes);
    const padded = Buffer.concat([Buffer.from('padding'), bytes, Buffer.from('padding')]);
    const view = padded.subarray(7, 7 + bytes.length);
    for (const source of [path, pathToFileURL(path), bytes, view, Uint8Array.from(bytes).buffer]) {
      expect(success(await parseAsync('guaranty-trust-bank', source)).transactions).toHaveLength(2);
    }
    expect(bytes).toEqual(before);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  test('normalizes 90-degree rotated statements', async () => {
    const normal = success(await parseAsync('gtbank', makePdf(layouts.gtbank)));
    const rotated = success(await parseAsync('gtbank', makePdf(layouts.gtbank, { rotate: true })));
    expect(rotated.toJSON()).toEqual(normal.toJSON());
  });

  test('detects banks and uses generic tables with an explicit warning', async () => {
    for (const bank of ['gtbank', 'zenith', 'uba', 'cowrywise'] as const) {
      expect(success(await parseAsync('auto', makePdf(layouts[bank]))).info.bank).toBe(bank);
    }
    const generic = success(await parseAsync('generic', makePdf(layouts.generic)));
    expect(generic.transactions.map((row) => row.amount)).toEqual([-5000, 10000]);
    expect(generic.warnings[0]).toContain('generic table');
    expect(success(await parseAsync('auto', makePdf(layouts.generic))).info.bank).toBe('generic');
  });

  test('recovers drawn table borders for generic lattice extraction', async () => {
    const pdf = makePdf(layouts.generic, { borders: true });
    const extracted = await extractPdf(Uint8Array.from(pdf));
    expect(extracted.rulings[0].length).toBeGreaterThanOrEqual(9);
    expect(success(await parseAsync('generic', pdf)).transactions.map((row) => row.amount)).toEqual([-5000, 10000]);
  });

  test('returns typed failures for unsupported banks and invalid arguments', async () => {
    for (const result of [
      parse('unknown-bank', path),
      await parseAsync('unknown-bank', path),
      parse('gtbank', null as unknown as StatementSource),
      await parseAsync('gtbank', new URL('https://example.com/statement.pdf')),
      parse('gtbank', path, { timeoutMs: 0 }),
      await parseAsync('gtbank', path, null as never),
    ]) {
      expect(result.error).toBeInstanceOf(StatementParseError);
      expect(result.error?.message.length).toBeGreaterThan(0);
      expect(result.data).toBeInstanceOf(StatementFailure);
      expect(result.data.status).toBe('error');
      expect(result.data.transactions).toEqual([]);
      expect('toCSV' in result.data).toBe(false);
    }
    expect(parse('toString', path).error?.code).toBe('unsupported_bank');
  });

  test('returns failures for missing, unreadable, empty and malformed PDFs', async () => {
    for (const parser of [parse, parseAsync]) {
      expect((await parser('gtbank', join(folder, 'missing.pdf'))).error?.code).toBe('file_not_found');
      expect((await parser('gtbank', folder)).error?.code).toBe('file_read_failed');
      expect((await parser('gtbank', new Uint8Array())).error?.code).toBe('invalid_pdf');
      expect((await parser('gtbank', Buffer.from('not a pdf'))).error?.code).toBe('invalid_pdf');
    }
  });

  test('distinguishes missing and incorrect passwords and unlocks encrypted PDFs', async () => {
    const encrypted = makePdf(layouts.gtbank, { password: 'test-password' });
    for (const parser of [parse, parseAsync]) {
      expect((await parser('gtbank', encrypted)).error?.code).toBe('password_required');
      expect((await parser('gtbank', encrypted, { password: 'wrong' })).error?.code).toBe('password_incorrect');
      expect(success(await parser('gtbank', encrypted, { password: 'test-password' })).transactions).toHaveLength(2);
    }
  });

  test('distinguishes unrecognized layouts from tables without transactions', async () => {
    expect((await parseAsync('gtbank', makePdf([[item('Unrecognized statement', 50, 700)]]))).error?.code).toBe('unsupported_layout');
    const header = layouts.gtbank[0].filter((row) => row.y >= 700);
    const result = await parseAsync('gtbank', makePdf([header]));
    expect(result.error?.code).toBe('no_transactions');
    expect(result.data.info.accountNumber).toBe('0123456789');
  });

  test('synchronous parsing has a configurable timeout', () => {
    expect(parse('gtbank', path, { timeoutMs: 1 }).error?.code).toBe('timeout');
  });

  for (const format of ['module', 'commonjs'] as const) {
    test(`built ${format} package works under Node without Bun`, () => {
      const load = format === 'module'
        ? `import { parse, parseAsync, Statement } from 'statement-kit';`
        : `const { parse, parseAsync, Statement } = require('statement-kit');`;
      const code = `${load}
        (async () => {
          const a = parse('gtbank', process.argv[1]);
          const b = await parseAsync('gtbank', process.argv[1]);
          const { readFileSync } = await import('node:fs');
          const bytes = readFileSync(process.argv[1]);
          const blob = await parseAsync('gtbank', new Blob([bytes]));
          const file = await parseAsync('gtbank', new File([bytes], 'statement.pdf'));
          if (a.error || b.error || !(a.data instanceof Statement) || !(b.data instanceof Statement) ||
              blob.error || file.error || a.data.transactions.length !== 2 ||
              JSON.stringify(a.data) !== JSON.stringify(b.data) ||
              JSON.stringify(a.data) !== JSON.stringify(blob.data) ||
              JSON.stringify(a.data) !== JSON.stringify(file.data)) process.exit(1);
          console.log(a.data.toCSV());
        })().catch((error) => { console.error(error); process.exitCode = 1; });`;
      const run = spawnSync('node', [`--input-type=${format}`, '-e', code, path], { encoding: 'utf8', windowsHide: true });
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('POS PURCHASE');
    });
  }

  test('exports the supported institution list', () => {
    expect(supportedBanks.map((bank) => bank.id)).toEqual(['gtbank', 'zenith', 'uba', 'cowrywise']);
  });
});

describe('statement exports', () => {
  const statement = new Statement({ bank: 'gtbank', bankName: 'GTBank' }, [
    { date: Date.UTC(2026, 1, 1), description: 'Transfer, "rent"\nsecond line', amount: -12.5, reference: 'REF\t01' },
    { date: Date.UTC(2026, 1, 2), description: '=1+1', amount: 20, balance: 100, reference: '@SUM(A1)' },
  ]);

  test('quotes CSV and TSV fields and preserves empty optional values', () => {
    expect(statement.toCSV()).toBe('date,description,amount,balance,reference\r\n2026-02-01,"Transfer, ""rent""\nsecond line",-12.50,,REF\t01\r\n2026-02-02,\'=1+1,20.00,100.00,\'@SUM(A1)');
    expect(statement.toTSV()).toContain('"REF\t01"');
    expect(statement.toCSV({ header: false, newline: '\n', escapeFormulas: false })).toContain('\n2026-02-02,=1+1,20.00,100.00,@SUM(A1)');
    expect(statement.toDelimited(';')).toContain('date;description;amount;balance;reference');
    expect(() => statement.toDelimited('')).toThrow(TypeError);
  });

  test('JSON snapshots are independent from the original statement', () => {
    const json = statement.toJSON();
    json.transactions[0].description = 'changed';
    expect(statement.transactions[0].description).toContain('rent');
    expect(JSON.parse(JSON.stringify(statement))).toEqual(statement.toJSON());
    expect(Object.isFrozen(statement.info)).toBe(true);
    expect(Object.isFrozen(statement.transactions[0])).toBe(true);
  });
});
