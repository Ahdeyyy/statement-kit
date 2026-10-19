import { bankDisplayName, bankParsers } from './banks.js';
import { StatementParseError } from './errors.js';
import { Statement, StatementFailure } from './statement.js';
import type { BankName, ParseResult, ParserName } from './types.js';
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
  const parser = selected === 'generic'
    ? (genericLinesParser.detect(pages, rulings) ? genericLinesParser : genericParser)
    : bankParsers[selected];
  const detected = selected === 'generic'
    ? parser === genericLinesParser ? genericLinesParser.detect(pages, rulings) : genericParser.detect(pages)
    : bankParsers[selected].detect(pages);
  if (!detected) {
    const error = new StatementParseError('unsupported_layout', `Could not recognize a supported ${bankDisplayName(selected)} layout.`);
    return { data: new StatementFailure(error, { bank: selected, bankName: bankDisplayName(selected) }), error };
  }
  const raw = selected === 'generic'
    ? parser === genericLinesParser ? genericLinesParser.parse(pages, rulings) : genericParser.parse(pages)
    : bankParsers[selected].parse(pages);
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
