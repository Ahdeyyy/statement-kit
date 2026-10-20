import type { Statement, StatementFailure } from './statement.js';
import type { StatementParseError } from './errors.js';
import type { bankAliases } from './banks.js';

export type BankName = 'gtbank' | 'zenith' | 'uba' | 'cowrywise';
export type ParserName = BankName | 'generic';
/** Canonical IDs are suggested by editors; aliases and runtime strings remain accepted. */
export type ParserInput = ParserName | 'auto' | (string & {});

type BankCharacter =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

// Mirror resolveBank's ASCII normalization. Bound recursion for long runtime inputs.
type NormalizeBank<S extends string, Out extends string = '', Depth extends unknown[] = []> =
  string extends S ? string : Depth['length'] extends 128 ? string :
  S extends `${infer Head}${infer Tail}`
    ? NormalizeBank<Tail, `${Out}${Head extends BankCharacter ? Head : ''}`, [...Depth, unknown]>
    : S extends '' ? Out : string;

/** Resolve literal aliases; auto, unknown names and runtime strings allow every parser. */
export type ResolvedParser<B extends string> = B extends unknown
  ? NormalizeBank<Lowercase<B>> extends infer Name extends string
    ? Name extends keyof typeof bankAliases
      ? (typeof bankAliases)[Name] extends ParserName ? (typeof bankAliases)[Name] : ParserName
      : ParserName
    : never
  : never;
export type StatementSource = string | URL | Uint8Array | ArrayBuffer;
/** Library-independent inputs supported by the browser entry point. File extends Blob. */
export type BrowserStatementSource = Uint8Array | ArrayBuffer | Blob;
export type AsyncStatementSource = StatementSource | Blob;

export type StatementInfo<B extends ParserName = ParserName> = {
  bank: B;
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
  /** Running balance, when available. Dedicated bank parser results require this field. */
  balance?: number;
  /** Printed reference. Currently emitted by GTBank and generic extraction only. */
  reference?: string;
};

/** Dedicated parsers only emit rows with a readable running balance. */
type BalancedTransaction = Omit<Transaction, 'balance' | 'reference'> & {
  /** Running balance in major currency units; always present on this parser's rows. */
  balance: number;
};

/** Fields actually emitted by each parser, rather than every column printed by the bank. */
export type TransactionByParser = {
  gtbank: BalancedTransaction & {
    /** Printed reference, when readable. */
    reference?: string;
  };
  zenith: BalancedTransaction;
  uba: BalancedTransaction;
  cowrywise: BalancedTransaction;
  generic: Transaction;
};

/** A mutable row shape; statement instances expose readonly snapshots of these rows. */
export type TransactionFor<B extends ParserName = ParserName> = TransactionByParser[B];

/** A union of complete statements keeps the bank and its row shape correlated. */
export type StatementFor<B extends ParserName = ParserName> = {
  [P in B]: Statement<TransactionFor<P>, P>;
}[B];

export type ParseOptions = {
  password?: string;
  /** Synchronous parse() child-process timeout, in milliseconds. Default: 120000. */
  timeoutMs?: number;
};

export type BrowserParseOptions = Pick<ParseOptions, 'password'>;

export type ExportOptions = {
  /** Include the column header. Default: true. */
  header?: boolean;
  /** Prefix formula-like text with an apostrophe. Default: true. */
  escapeFormulas?: boolean;
  /** Default: CRLF for CSV, LF for TSV and custom delimiters. */
  newline?: '\n' | '\r\n';
};

/** Check error for success/failure, then data.bank to narrow an auto-detected parser. */
export type ParseResult<B extends ParserName = ParserName> =
  | { data: StatementFor<B>; error: null }
  | { data: StatementFailure; error: StatementParseError };
