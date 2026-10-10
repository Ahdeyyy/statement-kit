import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBank } from './banks.js';
import { normalizeError, StatementParseError } from './errors.js';
import { Statement, StatementFailure } from './statement.js';
import { parsePages } from './core.js';
import type { ParseOptions, ParseResult, StatementSource } from './types.js';

function failure(error: unknown): ParseResult {
  const normalized = normalizeError(error);
  return { data: new StatementFailure(normalized), error: normalized };
}

function validate(source: StatementSource, options: ParseOptions): void {
  if (typeof source === 'string') {
    if (!source.trim() || source.includes('\0')) {
      throw new StatementParseError('invalid_input', 'Provide a non-empty statement file path.');
    }
  } else if (source instanceof URL) {
    if (source.protocol !== 'file:') throw new StatementParseError('invalid_input', 'Only file: URLs are supported.');
  } else if (!(source instanceof Uint8Array) && !(source instanceof ArrayBuffer)) {
    throw new StatementParseError('invalid_input', 'Provide a file path, file URL, Uint8Array, Buffer or ArrayBuffer.');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (options.password !== undefined && typeof options.password !== 'string') ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0))) {
    throw new StatementParseError('invalid_input', 'Options must contain a string password and/or a positive integer timeoutMs.');
  }
}

function binary(source: Uint8Array | ArrayBuffer): Uint8Array {
  // PDF.js may transfer its input; never detach or mutate caller-owned bytes.
  return source instanceof Uint8Array ? new Uint8Array(source) : new Uint8Array(source.slice(0));
}

/** Parse without throwing or returning a promise. Requires child-process support. */
export function parse(bank: string, source: StatementSource, options: ParseOptions = {}): ParseResult {
  try {
    const selected = resolveBank(bank);
    validate(source, options);
    const bytes = typeof source === 'string' || source instanceof URL
      ? new Uint8Array(readFileSync(source)) : binary(source);
    if (bytes.length === 0) throw new StatementParseError('invalid_pdf', 'The PDF is empty.');
    let worker = fileURLToPath(new URL('./pdf-worker.js', import.meta.url));
    if (!existsSync(worker)) {
      // Bun can run the development entry directly before building the package.
      const typescriptWorker = fileURLToPath(new URL('./pdf-worker.ts', import.meta.url));
      if (process.versions.bun && existsSync(typescriptWorker)) worker = typescriptWorker;
    }
    const child = spawnSync(process.execPath, [worker], {
      input: JSON.stringify({ bank: selected, pdf: Buffer.from(bytes).toString('base64'), password: options.password }),
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      // Do not inherit loader/test-runner flags from the caller.
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    if (child.error) throw child.error;
    if (child.status !== 0 || !child.stdout) {
      throw new StatementParseError('parse_failed', 'The PDF parsing process could not complete.');
    }
    const result = JSON.parse(child.stdout) as ParseResult;
    if (result.error) {
      const error = new StatementParseError(result.error.code, result.error.message);
      return { data: new StatementFailure(error, result.data.info, result.data.warnings), error };
    }
    return { data: new Statement(result.data.info, result.data.transactions, result.data.warnings), error: null };
  } catch (error) {
    return failure(error);
  }
}

/** Parse in the current process. All input, PDF and parser failures are returned. */
export async function parseAsync(bank: string, source: StatementSource, options: ParseOptions = {}): Promise<ParseResult> {
  try {
    const selected = resolveBank(bank);
    validate(source, options);
    const bytes = typeof source === 'string' || source instanceof URL
      ? new Uint8Array(await readFile(source)) : binary(source);
    const { extractPdf } = await import('./pdf.js');
    const { pages, rulings } = await extractPdf(bytes, options.password);
    return parsePages(selected, pages, rulings);
  } catch (error) {
    return failure(error);
  }
}
