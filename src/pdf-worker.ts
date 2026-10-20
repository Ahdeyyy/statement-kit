// Private protocol entry for synchronous parse(); not a package export.
import { readFileSync } from 'node:fs';
import { parseAsync } from './parse.js';
import type { StatementParseError } from './errors.js';
import type { StatementFailure } from './statement.js';
import type { ParserName, StatementFor } from './types.js';

/** JSON has no class methods; the envelope preserves the bank/row association. */
export type WorkerResult = {
  [B in ParserName]: { bank: B; data: ReturnType<StatementFor<B>['toJSON']>; error: null };
}[ParserName] | {
  data: Pick<StatementFailure, 'info' | 'warnings'>;
  error: Pick<StatementParseError, 'code' | 'message'>;
};

async function main(): Promise<void> {
  try {
    const request = JSON.parse(readFileSync(0, 'utf8')) as { bank: string; pdf: string; password?: string };
    const result = await parseAsync(request.bank, Buffer.from(request.pdf, 'base64'), { password: request.password });
    process.stdout.write(JSON.stringify(result.error ? result : { ...result, bank: result.data.bank }));
  } catch {
    process.exitCode = 1;
  }
}

void main();
