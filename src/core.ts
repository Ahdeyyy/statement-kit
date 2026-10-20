import { bankDisplayName, bankParsers } from './banks.js';
import { StatementParseError } from './errors.js';
import { Statement, StatementFailure } from './statement.js';
import type { BankName, ParseResult, ParserName, TransactionFor } from './types.js';
import type { ParseResult as ParserResult } from './parsers/types.js';
import type { Item, Ruling } from './parsers/pdf-shared.js';
import { genericParser } from './parsers/pdf-generic.js';
import { genericLinesParser } from './parsers/pdf-generic-lines.js';

export function parsePages(bank: BankName | 'auto' | 'generic', pages: Item[][], rulings: Ruling[][]): ParseResult {
  let selected: ParserName = bank === 'auto' ? 'generic' : bank;
  if (bank === 'auto') {
    // Try dedicated bank parsers in priority order before considering generic tables.
    for (const name of ['zenith', 'cowrywise', 'zap', 'uba', 'gtbank'] as const) {
      if (bankParsers[name].detect(pages)) { selected = name; break; }
    }
  }
  // Keep each literal ID paired with its parser's row type through construction.
  switch (selected) {
    case 'gtbank': return parseBank('gtbank', pages);
    case 'zenith': return parseBank('zenith', pages);
    case 'uba': return parseBank('uba', pages);
    case 'cowrywise': return parseBank('cowrywise', pages);
    case 'zap': return parseBank('zap', pages);
    case 'generic': {
      const lined = genericLinesParser.detect(pages, rulings);
      return statementResult('generic', lined || genericParser.detect(pages), () =>
        lined ? genericLinesParser.parse(pages, rulings) : genericParser.parse(pages));
    }
  }
}

type ParserOutcome<B extends ParserName> =
  | { data: Statement<TransactionFor<B>, B>; error: null }
  | Extract<ParseResult, { error: StatementParseError }>;

function parseBank<B extends BankName>(bank: B, pages: Item[][]): ParserOutcome<B> {
  const parser = bankParsers[bank];
  return statementResult(bank, parser.detect(pages), () => parser.parse(pages));
}

function statementResult<B extends ParserName>(
  selected: B, detected: boolean, load: () => ParserResult<B>,
): ParserOutcome<B> {
  if (!detected) {
    const error = new StatementParseError('unsupported_layout', `Could not recognize a supported ${bankDisplayName(selected)} layout.`);
    return { data: new StatementFailure(error, { bank: selected, bankName: bankDisplayName(selected) }), error };
  }
  const raw = load();
  const info = { ...raw.meta, bank: selected, bankName: bankDisplayName(selected) };
  if (raw.rows.length === 0) {
    const error = new StatementParseError('no_transactions', 'No readable transactions were found in the statement.');
    return { data: new StatementFailure(error, info, raw.warnings), error };
  }
  if (raw.rows.some((row) => !Number.isFinite(row.date) || !Number.isFinite(row.amount) ||
      (row.balance !== undefined && !Number.isFinite(row.balance)))) {
    throw new StatementParseError('parse_failed', 'The statement contains invalid transaction values.');
  }
  const warnings = selected === 'generic'
    ? ['Parsed using generic table detection; verify the extracted transactions.', ...raw.warnings]
    : raw.warnings;
  return { data: new Statement(info, raw.rows, warnings), error: null };
}
