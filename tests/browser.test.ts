import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import * as browser from '../src/browser.js';
import { parse, parseAsync as parseNode } from '../src/index.js';
import type { ParseResult, StatementSource } from '../src/browser.js';
import { layouts, makePdf } from './fixtures/pdf.js';

function success(result: ParseResult) {
  expect(result.error).toBeNull();
  if (result.error) throw result.error;
  return result.data;
}

describe('browser entry point', () => {
  test('bundles the published entry and its PDF engine for browsers', async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./fixtures/browser-entry.js', import.meta.url))],
      target: 'browser',
      minify: true,
    });
    expect(result.logs).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);
    expect('parse' in browser).toBe(false);
  });

  test('bytes, subarrays, ArrayBuffers, Blob and File match Node results without changing input', async () => {
    const pdf = Uint8Array.from(makePdf(layouts.gtbank));
    const expected = success(await parseNode('gtbank', pdf));
    const padded = new Uint8Array(pdf.length + 12);
    padded.set(pdf, 6);
    const view = padded.subarray(6, 6 + pdf.length);
    const before = padded.slice();
    const buffer = Uint8Array.from(pdf).buffer;
    for (const source of [view, buffer, new Blob([pdf]), new File([pdf], 'statement.pdf')]) {
      const result = await browser.parseAsync('GTB', source);
      expect(result.error).toBeNull();
      expect(result.data).toBeInstanceOf(browser.Statement);
      expect(success(result).toJSON()).toEqual(expected.toJSON());
      if (!result.error) expect(result.data.toCSV()).toContain('POS PURCHASE');
    }
    expect(padded).toEqual(before);
    expect(new Uint8Array(buffer)).toEqual(Uint8Array.from(pdf));
    expect(success(await parseNode('gtbank', new Blob([pdf]))).toJSON()).toEqual(expected.toJSON());
    expect(success(await parseNode('gtbank', new File([pdf], 'statement.pdf'))).toJSON()).toEqual(expected.toJSON());
    // Synchronous parsing cannot read the asynchronous Blob API.
    expect(parse('gtbank', new Blob([pdf]) as never).error?.code).toBe('invalid_input');
  });

  test('all bank layouts, automatic detection, rotation and generic borders work', async () => {
    for (const bank of ['gtbank', 'zenith', 'uba', 'cowrywise'] as const) {
      const pdf = Uint8Array.from(makePdf(layouts[bank], { rotate: bank === 'gtbank' }));
      const expected = success(await parseNode(bank, pdf));
      const result = await browser.parseAsync('auto', new File([pdf], `${bank}.pdf`));
      expect(result.error).toBeNull();
      expect(success(result).toJSON()).toEqual(expected.toJSON());
    }
    const pdf = Uint8Array.from(makePdf(layouts.generic, { borders: true }));
    const result = await browser.parseAsync('generic', new Blob([pdf]));
    expect(result.error).toBeNull();
    expect(success(result).toJSON()).toEqual(success(await parseNode('generic', pdf)).toJSON());
  });

  test('password failures and successful decryption retain the public contract', async () => {
    const pdf = new Blob([Uint8Array.from(makePdf(layouts.gtbank, { password: 'test-password' }))]);
    expect((await browser.parseAsync('gtbank', pdf)).error?.code).toBe('password_required');
    expect((await browser.parseAsync('gtbank', pdf, { password: 'wrong' })).error?.code).toBe('password_incorrect');
    const result = await browser.parseAsync('gtbank', pdf, { password: 'test-password' });
    expect(result.error).toBeNull();
    expect(result.data.transactions).toHaveLength(2);
  });

  test('invalid inputs and options return failures without rejecting', async () => {
    for (const source of [null, 'statement.pdf', new URL('file:///statement.pdf'), {}, { getPage() {} }]) {
      const result = await browser.parseAsync('gtbank', source as StatementSource);
      expect(result.error?.code).toBe('invalid_input');
      expect(result.error).toBeInstanceOf(browser.StatementParseError);
      expect(result.data).toBeInstanceOf(browser.StatementFailure);
      if (result.error) expect(result.data.error).toBe(result.error);
    }
    expect((await browser.parseAsync('gtbank', new Blob())).error?.code).toBe('invalid_pdf');
    expect((await browser.parseAsync('gtbank', new Blob(['not a PDF']))).error?.code).toBe('invalid_pdf');
    expect((await browser.parseAsync('unknown', new Blob())).error?.code).toBe('unsupported_bank');
    expect((await browser.parseAsync('gtbank', new Blob(), null as never)).error?.code).toBe('invalid_input');
    expect((await browser.parseAsync('gtbank', new Blob(), { password: 123 } as never)).error?.code).toBe('invalid_input');
    class UnreadableBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error('Read failed'); }
    }
    expect((await browser.parseAsync('gtbank', new UnreadableBlob())).error?.code).toBe('parse_failed');
    expect((await parseNode('gtbank', new UnreadableBlob())).error?.code).toBe('parse_failed');
  });
});
