/** Internal result shared by the bank statement parsers. */
export type ParsedTransaction = {
  /** UTC midnight, in milliseconds. */
  date: number;
  description: string;
  /** Negative for debits, positive for credits; in major currency units. */
  amount: number;
  balance?: number;
  reference?: string;
};

export type StatementMeta = {
  accountNumber?: string;
  accountName?: string;
  currency?: string;
  openingBalance?: number;
  period?: string;
};

export type ParseResult = {
  rows: ParsedTransaction[];
  meta: StatementMeta;
  warnings: string[];
};
