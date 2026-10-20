import { parseSource, readBinary } from './parse-shared.js';
import type { BrowserParseOptions, BrowserStatementSource, ParseResult, ParserInput, ResolvedParser } from './types.js';

/**
 * Parse PDF bytes or a File/Blob locally. All failures are returned.
 * Literal bank names and aliases infer row fields. After success, check data.bank to narrow auto results.
 */
export function parseAsync<B extends ParserInput>(
  bank: B, source: BrowserStatementSource, options?: BrowserParseOptions,
): Promise<ParseResult<ResolvedParser<B>>>;
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
  BankName, ParserName, ParserInput, ResolvedParser, BrowserStatementSource, BrowserStatementSource as StatementSource,
  BrowserParseOptions, BrowserParseOptions as ParseOptions, StatementInfo, Transaction,
  ExportOptions, ParseResult, TransactionByParser, TransactionFor, StatementFor,
} from './types.js';
