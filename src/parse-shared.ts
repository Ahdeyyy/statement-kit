import { resolveBank } from './banks.js';
import { parsePages } from './core.js';
import { normalizeError, StatementParseError } from './errors.js';
import { StatementFailure } from './statement.js';
import type { ParseOptions, ParseResult } from './types.js';

export function failure(error: unknown): ParseResult {
  const normalized = normalizeError(error);
  return { data: new StatementFailure(normalized), error: normalized };
}

export function validateOptions(options: ParseOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (options.password !== undefined && typeof options.password !== 'string') ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0))) {
    throw new StatementParseError('invalid_input', 'Options must contain a string password and/or a positive integer timeoutMs.');
  }
}

export function binary(source: Uint8Array | ArrayBuffer): Uint8Array {
  // PDF.js may transfer its input; never detach or mutate caller-owned bytes.
  return source instanceof Uint8Array ? new Uint8Array(source) : new Uint8Array(source.slice(0));
}

export async function readBinary(source: unknown): Promise<Uint8Array> {
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return binary(source);
  // File extends Blob. No PDF-library-specific document type is required.
  if (typeof Blob !== 'undefined' && source instanceof Blob) return binary(await source.arrayBuffer());
  throw new StatementParseError('invalid_input', 'Provide PDF bytes as a Uint8Array or ArrayBuffer, or a File or Blob.');
}

/** Shared asynchronous pipeline; the entry point owns source loading. */
export async function parseSource<T>(
  bank: string, source: T, options: ParseOptions, load: (source: T) => Promise<Uint8Array>,
): Promise<ParseResult> {
  try {
    const selected = resolveBank(bank);
    validateOptions(options);
    const bytes = await load(source);
    const { extractPdf } = await import('./pdf.js');
    const { pages, rulings } = await extractPdf(bytes, options.password);
    return parsePages(selected, pages, rulings);
  } catch (error) {
    return failure(error);
  }
}
