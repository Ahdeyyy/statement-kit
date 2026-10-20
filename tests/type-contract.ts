import { parse, parseAsync, supportedBanks } from '../src/index.js';
import { parseAsync as parseBrowser } from '../src/browser.js';
import type {
  ParseResult, ParserInput, ParserName, ResolvedParser, Statement, StatementFor, Transaction, TransactionFor,
} from '../src/index.js';
import type { ParseResult as BrowserResult, TransactionFor as BrowserTransactionFor } from '../src/browser.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function sameType<T extends true>(): void {}
function accepts<T>(value: T): void { void value; }

// Compile-time regression: destructuring and checking error must narrow data.
export function checkResultContract(result: ParseResult): void {
  const { data, error } = result;
  if (error) {
    const status: 'error' = data.status;
    void status;
    // @ts-expect-error Failure data must not expose successful export methods.
    data.toCSV();
  } else {
    const status: 'success' = data.status;
    void status;
    data.toCSV();
    data.toTSV();
    data.toJSON();
  }
}

export function checkExplicitBanks(source: Uint8Array): void {
  const gtbank = parse('gtbank', source);
  sameType<Equal<typeof gtbank, ParseResult<'gtbank'>>>();
  const { data, error } = gtbank;
  if (!error) {
    accepts<'gtbank'>(data.bank);
    accepts<'gtbank'>(data.info.bank);
    accepts<number>(data.transactions[0].balance);
    accepts<string | undefined>(data.transactions[0].reference);
    // @ts-expect-error A supported reference may still be missing on a particular row.
    accepts<string>(data.transactions[0].reference);
    accepts<StatementFor<'gtbank'>>(data);
    // Existing broad annotations and bank-independent utilities still work.
    accepts<Statement>(data);
    accepts<Readonly<Transaction>>(data.transactions[0]);
    // @ts-expect-error Statement rows are readonly.
    data.transactions[0].balance = 1;
    // @ts-expect-error The array itself is readonly.
    data.transactions.push({ date: 0, description: '', amount: 0, balance: 0 });
    // @ts-expect-error Metadata is readonly.
    data.info.bank = 'gtbank';
    // @ts-expect-error The narrowing discriminator is readonly.
    data.bank = 'gtbank';

    const json = data.toJSON();
    accepts<'gtbank'>(json.info.bank);
    accepts<number>(json.transactions[0].balance);
    accepts<string | undefined>(json.transactions[0].reference);
    // JSON snapshots retain precise types and permit mutation.
    json.transactions[0].balance = 1;
    json.transactions[0].reference = 'REF';
    json.info.currency = 'NGN';
    json.warnings.push('reviewed');
  }

  const zenith = parse('zenith', source);
  const uba = parse('uba', source);
  const cowrywise = parse('cowrywise', source);
  sameType<Equal<typeof zenith, ParseResult<'zenith'>>>();
  sameType<Equal<typeof uba, ParseResult<'uba'>>>();
  sameType<Equal<typeof cowrywise, ParseResult<'cowrywise'>>>();
  for (const result of [zenith, uba, cowrywise]) {
    if (!result.error) {
      accepts<number>(result.data.transactions[0].balance);
      // @ts-expect-error These parsers do not emit references.
      result.data.transactions[0].reference;
      // @ts-expect-error The JSON return type must not widen back to Transaction[].
      result.data.toJSON().transactions[0].reference;
      // @ts-expect-error A column printed in a PDF is not necessarily exposed by its parser.
      result.data.transactions[0].valueDate;
    }
  }
  if (!cowrywise.error) {
    // @ts-expect-error Fees currently appear in the description, not a separate returned field.
    cowrywise.data.transactions[0].fee;
  }

  const generic = parse('generic', source);
  sameType<Equal<typeof generic, ParseResult<'generic'>>>();
  if (!generic.error) {
    accepts<'generic'>(generic.data.bank);
    accepts<number | undefined>(generic.data.transactions[0].balance);
    accepts<string | undefined>(generic.data.transactions[0].reference);
    // @ts-expect-error Generic extraction cannot promise a balance column.
    accepts<number>(generic.data.transactions[0].balance);
  }
}

export function checkAliases(source: Uint8Array): void {
  sameType<Equal<ReturnType<typeof parse<'GTBank'>>, ParseResult<'gtbank'>>>();
  accepts<ParseResult<'gtbank'>>(parse('GTB', source));
  accepts<ParseResult<'gtbank'>>(parse('gt', source));
  accepts<ParseResult<'gtbank'>>(parse('Guaranty-Trust Bank', source));
  accepts<ParseResult<'gtbank'>>(parse('  G.T.BANK!  ', source));
  accepts<ParseResult<'zenith'>>(parse('Zenith-Bank', source));
  accepts<ParseResult<'uba'>>(parse('United Bank for Africa', source));
  accepts<ParseResult<'cowrywise'>>(parse('COWRYWISE', source));
  accepts<ParseResult<'generic'>>(parse('GENERIC', source));
  sameType<Equal<ResolvedParser<'AUTO'>, ParserName>>();
  sameType<Equal<ResolvedParser<'unknown-bank'>, ParserName>>();
  sameType<Equal<ResolvedParser<'GTB' | 'UBA'>, 'gtbank' | 'uba'>>();
  sameType<Equal<ResolvedParser<string>, ParserName>>();
  // Long and partially known strings safely fall back instead of exhausting the compiler.
  type LongName = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  sameType<Equal<ResolvedParser<`${LongName}${LongName}${LongName}`>, ParserName>>();
  sameType<Equal<ResolvedParser<`gtbank${string}`>, ParserName>>();
}

export function checkDetectionAndDynamicInputs(source: Uint8Array, bank: string, either: 'GTB' | 'UBA'): void {
  const { data, error } = parse('auto', source);
  if (error) {
    accepts<'error'>(data.status);
    // @ts-expect-error Failure diagnostics cannot promise a detected bank.
    accepts<ParserName>(data.info.bank);
    // @ts-expect-error Failure data cannot export transactions.
    data.toCSV();
    return;
  }
  // @ts-expect-error Auto can select generic extraction, whose balance is optional.
  accepts<number>(data.transactions[0].balance);
  // @ts-expect-error References are unavailable on some of the possible banks.
  data.transactions[0].reference;

  switch (data.bank) {
    case 'gtbank':
      accepts<number>(data.transactions[0].balance);
      accepts<string | undefined>(data.transactions[0].reference);
      accepts<'gtbank'>(data.toJSON().info.bank);
      break;
    case 'zenith':
    case 'uba':
    case 'cowrywise':
      accepts<number>(data.transactions[0].balance);
      // @ts-expect-error Narrowing must remove unsupported fields from suggestions.
      data.transactions[0].reference;
      break;
    case 'generic':
      accepts<number | undefined>(data.transactions[0].balance);
      accepts<string | undefined>(data.transactions[0].reference);
      break;
    default:
      accepts<never>(data);
  }

  const dynamic = parse(bank, source);
  sameType<Equal<typeof dynamic, ParseResult>>();
  if (!dynamic.error && dynamic.data.bank === 'uba') {
    accepts<'uba'>(dynamic.data.info.bank);
    accepts<number>(dynamic.data.transactions[0].balance);
  }
  const union = parse(either, source);
  sameType<Equal<typeof union, ParseResult<'gtbank' | 'uba'>>>();
  if (!union.error) {
    accepts<number>(union.data.transactions[0].balance);
    if (union.data.bank === 'gtbank') accepts<string | undefined>(union.data.transactions[0].reference);
  }
  const fromList = parse(supportedBanks[0].id, source);
  accepts<ParseResult<'gtbank'>>(fromList);

  // Unknown strings keep the existing runtime unsupported_bank failure contract.
  accepts<ParseResult>(parse('unknown-bank', source));
}

function wrappedParse<B extends ParserInput>(bank: B, source: Uint8Array): ParseResult<ResolvedParser<B>> {
  return parse(bank, source);
}

export async function checkAsyncEntries(source: Uint8Array): Promise<void> {
  const node = await parseAsync('United-Bank-for-Africa', source);
  const browser = await parseBrowser('United-Bank-for-Africa', new Blob([Uint8Array.from(source)]));
  sameType<Equal<typeof node, ParseResult<'uba'>>>();
  sameType<Equal<typeof browser, BrowserResult<'uba'>>>();
  sameType<Equal<BrowserTransactionFor<'uba'>, TransactionFor<'uba'>>>();
  for (const result of [node, browser]) {
    if (!result.error) {
      accepts<'uba'>(result.data.bank);
      accepts<number>(result.data.transactions[0].balance);
      // @ts-expect-error Both entries must omit unsupported references.
      result.data.transactions[0].reference;
    }
  }
  const auto = await parseBrowser('auto', source);
  if (!auto.error && auto.data.bank === 'gtbank') {
    accepts<string | undefined>(auto.data.transactions[0].reference);
    accepts<number>(auto.data.toJSON().transactions[0].balance);
  }
  // @ts-expect-error Browser options must continue to exclude Node's timeoutMs.
  parseBrowser('gtbank', source, { timeoutMs: 1000 });
  sameType<Equal<ReturnType<typeof wrappedParse<'GTB'>>, ParseResult<'gtbank'>>>();
}

export function checkParserRowContracts(): void {
  const base = { date: 0, description: '', amount: 0 };
  accepts<TransactionFor<'generic'>>(base);
  // @ts-expect-error Dedicated parser rows must always carry a balance.
  accepts<TransactionFor<'gtbank'>>(base);
  accepts<TransactionFor<'gtbank'>>({ ...base, balance: 0, reference: 'REF' });
  // @ts-expect-error UBA does not return a reference field.
  accepts<TransactionFor<'uba'>>({ ...base, balance: 0, reference: 'REF' });
}
