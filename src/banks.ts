import type { BankName, ParserName } from './types.js';
import { StatementParseError } from './errors.js';
import { gtbankParser } from './parsers/pdf-gtbank.js';
import { zenithParser } from './parsers/pdf-zenith.js';
import { ubaParser } from './parsers/pdf-uba.js';
import { cowrywiseParser } from './parsers/pdf-cowrywise.js';
import type { PdfStatementParser } from './parsers/pdf-shared.js';

export const supportedBanks = Object.freeze([
  Object.freeze({ id: 'gtbank', name: 'Guaranty Trust Bank (GTBank)' }),
  Object.freeze({ id: 'zenith', name: 'Zenith Bank' }),
  Object.freeze({ id: 'uba', name: 'United Bank for Africa (UBA)' }),
  Object.freeze({ id: 'cowrywise', name: 'Cowrywise (Stash)' }),
] as const);

export const bankParsers: { [B in BankName]: PdfStatementParser<B> } = {
  gtbank: gtbankParser,
  zenith: zenithParser,
  uba: ubaParser,
  cowrywise: cowrywiseParser,
};

export const bankAliases = {
  gtbank: 'gtbank', gtb: 'gtbank', gt: 'gtbank', guarantytrustbank: 'gtbank',
  zenith: 'zenith', zenithbank: 'zenith',
  uba: 'uba', unitedbankforafrica: 'uba',
  cowrywise: 'cowrywise', auto: 'auto', generic: 'generic',
} as const satisfies Record<string, ParserName | 'auto'>;

export function resolveBank(bank: string): BankName | 'auto' | 'generic' {
  if (typeof bank !== 'string') throw new StatementParseError('invalid_input', 'The bank name must be a string.');
  const key = bank.toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = Object.hasOwn(bankAliases, key) ? bankAliases[key as keyof typeof bankAliases] : undefined;
  if (!name) {
    throw new StatementParseError('unsupported_bank', 'Unsupported bank. Use gtbank, zenith, uba, cowrywise, auto or generic.');
  }
  return name;
}

export function bankDisplayName(bank: ParserName): string {
  return supportedBanks.find((entry) => entry.id === bank)?.name ?? 'Generic statement';
}
