import type { ParserName, TransactionFor } from '../types.js';

/** The public row contract also checks the bank parsers' implementations. */
export type ParsedTransaction<B extends ParserName = ParserName> = TransactionFor<B>;

export type StatementMeta = {
  accountNumber?: string;
  accountName?: string;
  currency?: string;
  openingBalance?: number;
  period?: string;
};

export type ParseResult<B extends ParserName = ParserName> = {
  rows: ParsedTransaction<B>[];
  meta: StatementMeta;
  warnings: string[];
};
