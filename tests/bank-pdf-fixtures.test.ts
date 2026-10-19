import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDocumentProxy } from 'unpdf';
import { parse, parseAsync } from '../src/index.js';
import type { BankName, StatementInfo, Transaction } from '../src/index.js';

type Expected = { info: StatementInfo; transactions: Transaction[]; warnings: string[] };
type Fixture = {
  id: string; bank: BankName; pages: number; rows: number; rotation: number; size: number[];
  pdf: string; expected: string; pdfSha256: string; expectedSha256: string;
};
const directory = new URL('./fixtures/statements/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as { fixtures: Fixture[] };
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('checked-in randomized bank statement PDFs', () => {
  for (const fixture of manifest.fixtures) {
    const pdfUrl = new URL(fixture.pdf, directory);
    const expectedUrl = new URL(fixture.expected, directory);
    const expected = JSON.parse(readFileSync(expectedUrl, 'utf8')) as Expected;

    test(`${fixture.id}: fixture integrity, page geometry and independent ledger`, async () => {
      const bytes = readFileSync(pdfUrl);
      expect(hash(bytes)).toBe(fixture.pdfSha256);
      expect(hash(readFileSync(expectedUrl))).toBe(fixture.expectedSha256);
      expect(expected.transactions).toHaveLength(fixture.rows);
      let balance = Math.round(expected.info.openingBalance! * 100);
      for (const transaction of expected.transactions) {
        // Externally funded Zap payments do not change the wallet balance.
        if (transaction.balance !== undefined) {
          balance += Math.round(transaction.amount * 100);
          expect(Math.round(transaction.balance * 100)).toBe(balance);
        } else {
          expect(fixture.bank).toBe('zap');
        }
        expect(new Date(transaction.date).getUTCHours()).toBe(0);
        expect(Number.isFinite(transaction.amount)).toBe(true);
      }
      const pdf = await getDocumentProxy(Uint8Array.from(bytes), { verbosity: 0 });
      try {
        expect(pdf.numPages).toBe(fixture.pages);
        const first = await pdf.getPage(1);
        expect(first.rotate).toBe(fixture.rotation);
        expect(first.view).toEqual([0, 0, ...fixture.size]);
      } finally {
        await pdf.loadingTask.destroy();
      }
    }, 30_000);

    if (fixture.bank === 'zap') {
      test('zap: auto detection matches the independent expectations', async () => {
        const result = await parseAsync('auto', pdfUrl);
        expect(result.error).toBeNull();
        if (result.error) throw result.error;
        expect(result.data.toJSON()).toEqual(expected);
      });
    }

    test(`${fixture.id}: parseAsync matches every expected field and transaction`, async () => {
      const result = await parseAsync(fixture.bank, pdfUrl);
      expect(result.error).toBeNull();
      if (result.error) throw result.error;
      expect(result.data.toJSON()).toEqual(expected);
      expect(result.data.toCSV().split('\r\n')).toHaveLength(fixture.rows + 1);
      expect(result.data.toTSV().split('\n')).toHaveLength(fixture.rows + 1);
    }, 30_000);

    test(`${fixture.id}: synchronous parse matches the same independent expectations`, () => {
      const result = parse(fixture.bank, fileURLToPath(pdfUrl));
      expect(result.error).toBeNull();
      if (result.error) throw result.error;
      expect(result.data.toJSON()).toEqual(expected);
    }, 30_000);
  }
});
