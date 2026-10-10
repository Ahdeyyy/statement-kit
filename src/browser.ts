import { parseSource, readBinary } from './parse-shared.js';
import type { BrowserParseOptions, BrowserStatementSource, ParseResult } from './types.js';

/** Parse PDF bytes or a File/Blob locally. All failures are returned. */
export function parseAsync(
  bank: string, source: BrowserStatementSource, options: BrowserParseOptions = {},
): Promise<ParseResult> {
  return parseSource(bank, source, options, readBinary);
}

export { Statement, StatementFailure } from './statement.js';
export { StatementParseError } from './errors.js';
export { supportedBanks } from './banks.js';
export type { ParseErrorCode } from './errors.js';
export type {
  BankName, ParserName, BrowserStatementSource, BrowserStatementSource as StatementSource,
  BrowserParseOptions, BrowserParseOptions as ParseOptions, StatementInfo, Transaction,
  ExportOptions, ParseResult,
} from './types.js';
