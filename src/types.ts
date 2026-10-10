import type { Statement, StatementFailure } from './statement.js';
import type { StatementParseError } from './errors.js';

export type BankName = 'gtbank' | 'zenith' | 'uba' | 'cowrywise';
export type ParserName = BankName | 'generic';
export type StatementSource = string | URL | Uint8Array | ArrayBuffer;

export type StatementInfo = {
  bank: ParserName;
  bankName: string;
  accountNumber?: string;
  accountName?: string;
  currency?: string;
  openingBalance?: number;
  /** Period as printed on the statement. */
  period?: string;
};

export type Transaction = {
  /** UTC midnight of the transaction date, in milliseconds. */
  date: number;
  description: string;
  /** Major currency units. Negative = debit; positive = credit. */
  amount: number;
  balance?: number;
  reference?: string;
};

export type ParseOptions = {
  password?: string;
  /** Synchronous parse() child-process timeout, in milliseconds. Default: 120000. */
  timeoutMs?: number;
};

export type ExportOptions = {
  /** Include the column header. Default: true. */
  header?: boolean;
  /** Prefix formula-like text with an apostrophe. Default: true. */
  escapeFormulas?: boolean;
  /** Default: CRLF for CSV, LF for TSV and custom delimiters. */
  newline?: '\n' | '\r\n';
};

/** Checking error narrows data to the matching success/failure class. */
export type ParseResult =
  | { data: Statement; error: null }
  | { data: StatementFailure; error: StatementParseError };
