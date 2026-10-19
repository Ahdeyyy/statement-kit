import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseAsync as parseBrowser } from '../src/browser.js';
import { parsePdfItems } from '../src/parsers/pdf-core.js';
import { zapParser } from '../src/parsers/pdf-zap.js';
import { item, layouts } from './fixtures/pdf.js';
import type { Item } from '../src/parsers/pdf-shared.js';

const header = (y = 700): Item[] => [
  item('DATE', 43, y), item('DESCRIPTION', 110, y), item('TYPE', 294, y),
  item('SOURCE', 345, y), item('AMOUNT', 442, y), item('BALANCE', 511, y),
];
const summary = [
  item('Powered by Paystack', 43, 790), item('Account Name: SYNTHETIC CUSTOMER', 340, 775),
  item('Account Number: 0000000001', 340, 762), item('Bank: Example Partner Bank', 340, 749),
  item('Period: 01 Jan 2035 - 31 Jan 2035', 340, 736),
  item('OPENING BALANCE', 58, 720), item('\u20a6100.00', 58, 707),
];
const footer = [item('Important Notice: Zap by Paystack is not a bank.', 43, 36)];
// Position values by their right edge, like Zap (not by the header's left edge).
const right = (text: string, edge: number, y: number): Item => ({ text, x: edge - text.length * 4, y, width: text.length * 4 });
const amount = (text: string, y: number) => right(text, 482, y);
const balance = (text: string, y: number) => right(text, 554, y);

describe('Zap statement parser', () => {
  test('requires Zap branding and the six-column table; rejects other layouts', () => {
    expect(zapParser.detect([[...summary, ...header(), ...footer]])).toBe(true);
    expect(zapParser.detect([[...summary, ...header()]])).toBe(false);
    expect(zapParser.detect([[...summary, ...footer]])).toBe(false);
    for (const pages of Object.values(layouts)) expect(zapParser.detect(pages)).toBe(false);
  });

  test('keeps signed amounts, wrapped descriptions and charges; excludes badges, times, types and sources', () => {
    const pages = [[...summary, ...header(680),
      item('Jan 02, 2035', 43, 650), item('11:59 PM', 43, 640), item('Transfer to FICTIONAL', 109, 650),
      item('MERCHANT - 000000001', 109, 639.5), item('SUCCESS', 117, 627),
      item('TRANSFER', 293, 651.5), item('Zap Balance', 344, 650), amount('-25.00', 650), balance('\u20a675.00', 650),
      item('Fee - TRANSFER', 116, 604), amount('-1.25', 604.75), balance('\u20a673.75', 604),
      item('Stamp Duty', 116, 586), amount('-2.50', 586.75), balance('\u20a671.25', 586),
      item('Jan 02, 2035', 43, 560), item('Data-EXAMPLE', 109, 560), item('BILL', 293, 561.5),
      item('PAYMENT', 293, 553.25), item('Bank Account', 344, 560), amount('-9.00', 560),
      item('Jan 03, 2035', 43, 520), item('Topup from FICTIONAL', 109, 520), item('Inward Transfer', 344, 520),
      amount('+1,000,000.00', 520), balance('\u20a61,000,071.25', 520), ...footer]];
    const result = zapParser.parse(pages);
    expect(result.meta).toEqual({ accountName: 'SYNTHETIC CUSTOMER', accountNumber: '0000000001',
      period: '01 Jan 2035 - 31 Jan 2035', openingBalance: 100, currency: 'NGN' });
    expect(result.warnings).toEqual([]);
    const date = Date.UTC(2035, 0, 2);
    expect(result.rows).toEqual([
      { date, description: 'Transfer to FICTIONAL MERCHANT - 000000001', amount: -25, balance: 75 },
      { date, description: 'Fee - TRANSFER', amount: -1.25, balance: 73.75 },
      { date, description: 'Stamp Duty', amount: -2.5, balance: 71.25 },
      { date, description: 'Data-EXAMPLE', amount: -9 },
      { date: Date.UTC(2035, 0, 3), description: 'Topup from FICTIONAL', amount: 1000000, balance: 1000071.25 },
    ]);
    expect(parsePdfItems(pages)).toEqual(result);
  });

  test('carries the date to a next-page charge, skipping repeated account headers and footers', () => {
    const pages = [[...summary, ...header(680), item('Jan 02, 2035', 43, 650), item('Transfer', 109, 650),
      amount('-25.00', 650), balance('\u20a675.00', 650), ...footer],
    [...summary, ...header(680), item('Fee - TRANSFER', 116, 650), amount('-1.00', 650), balance('\u20a674.00', 650), ...footer]];
    const result = zapParser.parse(pages);
    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toEqual({ date: Date.UTC(2035, 0, 2), description: 'Fee - TRANSFER', amount: -1, balance: 74 });
  });

  test('warns for orphan charges, other undated amounts and inconsistent balances', () => {
    const pages = [[...summary, ...header(680), item('Fee - TRANSFER', 116, 660), amount('-1.00', 660), balance('\u20a699.00', 660),
      item('Jan 02, 2035', 43, 630), item('Payment', 109, 630), amount('-25.00', 630), balance('\u20a610.00', 630),
      item('Unknown undated amount', 109, 600), amount('-2.00', 600), balance('\u20a68.00', 600), ...footer]];
    const result = zapParser.parse(pages);
    expect(result.rows).toHaveLength(1);
    expect(result.warnings).toEqual(['Skipped a Zap charge with no preceding transaction date.',
      'Skipped an undated Zap amount row that was not a fee or stamp duty.', '1 of 1 rows did not reconcile with the balance.']);
  });

  test('browser bytes and aliases match independent fixture expectations', async () => {
    const pdf = readFileSync(new URL('./fixtures/statements/zap.pdf', import.meta.url));
    const expected = JSON.parse(readFileSync(new URL('./fixtures/statements/zap.expected.json', import.meta.url), 'utf8'));
    for (const bank of ['zap', 'Zap by Paystack', 'auto']) {
      const result = await parseBrowser(bank, new Blob([Uint8Array.from(pdf)]));
      expect(result.error).toBeNull();
      if (result.error) throw result.error;
      expect(result.data.toJSON()).toEqual(expected);
    }
  });
});
