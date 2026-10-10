import type { StatementParseError } from './errors.js';
import type { ExportOptions, StatementInfo, Transaction } from './types.js';

const HEADERS = ['date', 'description', 'amount', 'balance', 'reference'];

export class Statement {
  readonly status = 'success' as const;
  readonly info: Readonly<StatementInfo>;
  readonly transactions: readonly Readonly<Transaction>[];
  readonly warnings: readonly string[];

  constructor(info: StatementInfo, transactions: readonly Transaction[], warnings: readonly string[] = []) {
    this.info = Object.freeze({ ...info });
    this.transactions = Object.freeze(transactions.map((row) => Object.freeze({ ...row })));
    this.warnings = Object.freeze([...warnings]);
  }

  toCSV(options: ExportOptions = {}): string {
    return this.toDelimited(',', { newline: '\r\n', ...options });
  }

  toTSV(options: ExportOptions = {}): string {
    return this.toDelimited('\t', options);
  }

  toDelimited(delimiter: string, options: ExportOptions = {}): string {
    if (typeof delimiter !== 'string' || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) {
      throw new TypeError('The delimiter must be one character other than a quote or newline.');
    }
    const cell = (value: string, isText = false): string => {
      if (isText && options.escapeFormulas !== false && /^[\s\uFEFF]*[=+\-@]/.test(value)) {
        value = "'" + value;
      }
      return value.includes(delimiter) || /["\r\n]/.test(value)
        ? '"' + value.replace(/"/g, '""') + '"'
        : value;
    };
    const rows = this.transactions.map((row) => [
      cell(new Date(row.date).toISOString().slice(0, 10)),
      cell(row.description, true),
      cell(row.amount.toFixed(2)),
      cell(row.balance === undefined ? '' : row.balance.toFixed(2)),
      cell(row.reference ?? '', true),
    ].join(delimiter));
    if (options.header !== false) rows.unshift(HEADERS.join(delimiter));
    return rows.join(options.newline ?? '\n');
  }

  /** A plain snapshot, also used by JSON.stringify(statement). */
  toJSON(): { info: StatementInfo; transactions: Transaction[]; warnings: string[] } {
    return {
      info: { ...this.info },
      transactions: this.transactions.map((row) => ({ ...row })),
      warnings: [...this.warnings],
    };
  }
}

/** Failure data has diagnostics and no successful transaction/export API. */
export class StatementFailure {
  readonly status = 'error' as const;
  readonly info: Readonly<Partial<StatementInfo>>;
  readonly transactions: readonly Transaction[] = Object.freeze([]);
  readonly warnings: readonly string[];

  constructor(
    public readonly error: StatementParseError,
    info: Partial<StatementInfo> = {},
    warnings: readonly string[] = [],
  ) {
    this.info = Object.freeze({ ...info });
    this.warnings = Object.freeze([...warnings]);
  }
}
