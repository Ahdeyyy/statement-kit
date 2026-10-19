// Zap lists wallet charges as undated rows beneath the parent transaction.
// Payments funded by a bank account have an amount but no Zap wallet balance.
import type { ParsedTransaction, ParseResult, StatementMeta } from './types.js';
import { cents, parseAmount, parseStatementDate } from './values.js';
import { clusterRows, pageText, type Item, type PdfStatementParser, type VisualRow } from './pdf-shared.js';

function money(text: string): number | null {
  return parseAmount(text.replace(/\u20a6/g, '').replace(/^\s*\+\s*/, ''));
}

function header(rows: VisualRow[]) {
  for (const row of rows) {
    const labels = ['DATE', 'DESCRIPTION', 'TYPE', 'SOURCE', 'AMOUNT', 'BALANCE'];
    const cells = labels.map((label) => row.items.find((item) => item.text.trim().toUpperCase() === label));
    if (cells.some((cell) => !cell)) continue;
    const [date, description, type, source, amount, balance] = cells as Item[];
    if (!(date.x < description.x && description.x < type.x && type.x < source.x && source.x < amount.x && amount.x < balance.x)) continue;
    return { y: row.y, description: description.x - 6, type: type.x - 6, source: source.x - 6,
      balance: (amount.x + amount.width + balance.x) / 2 };
  }
  return null;
}

function metadata(rows: VisualRow[]): StatementMeta {
  const text = pageText(rows);
  const meta: StatementMeta = {};
  const name = /account\s*name:\s*([^\n]+)/i.exec(text);
  const account = /account\s*number:\s*([^\n]+)/i.exec(text);
  const period = /period:\s*([^\n]+)/i.exec(text);
  if (name) meta.accountName = name[1].trim();
  if (account) meta.accountNumber = account[1].trim();
  if (period) meta.period = period[1].trim();
  if (/\u20a6|\bNGN\b/.test(text)) meta.currency = 'NGN';
  const opening = rows.flatMap((row) => row.items).find((item) => /^opening balance$/i.test(item.text.trim()));
  if (opening) {
    // The summary value is stacked below its label, alongside money in/out.
    for (const row of rows) {
      if (row.y >= opening.y || opening.y - row.y > 35) continue;
      const value = row.items.find((item) => Math.abs(item.x - opening.x) < 8 && money(item.text) !== null);
      if (value) { meta.openingBalance = money(value.text)!; break; }
    }
  }
  return meta;
}

function parseZap(pages: Item[][]): ParseResult {
  const meta = metadata(clusterRows(pages[0] ?? []));
  const rows: ParsedTransaction[] = [];
  const warnings: string[] = [];
  let columns: ReturnType<typeof header> = null;
  let date: number | null = null;
  let pending: ParsedTransaction | null = null;
  let balance = meta.openingBalance;
  let mismatches = 0;
  const flush = () => {
    if (!pending) return;
    if (pending.balance !== undefined) {
      if (balance !== undefined && cents(balance + pending.amount) !== cents(pending.balance)) mismatches++;
      balance = pending.balance;
    }
    // No balance means this payment was funded outside the Zap wallet.
    rows.push(pending);
    pending = null;
  };

  for (const page of pages) {
    const visualRows = clusterRows(page);
    const found = header(visualRows);
    if (found) columns = found;
    if (!columns) continue;
    for (const row of visualRows) {
      if (found && row.y >= found.y) continue;
      const line = row.items.map((item) => item.text).join(' ');
      if (/important notice:|generated on\s*-|page\s+\d+\s+of\s+\d+/i.test(line)) { flush(); break; }
      const dateText: string[] = [];
      const description: string[] = [];
      let amount: number | null = null;
      let running: number | null = null;
      for (const item of row.items) {
        const text = item.text.trim();
        if (item.x < columns.description) dateText.push(text);
        else if (item.x < columns.type) description.push(text);
        else if (item.x >= columns.source && money(text) !== null) {
          // Money is right-aligned; its left edge moves with the number of digits.
          if (item.x + item.width > columns.balance) running = money(text);
          else amount = money(text);
        }
      }
      const printedDate = parseStatementDate(dateText.join(' '));
      if (printedDate !== null) { flush(); date = printedDate; }
      const narrative = description.join(' ').trim();
      if (amount !== null) {
        flush();
        const charge = /^(fee\s*-|stamp duty\b)/i.test(narrative);
        if (printedDate === null && !charge) {
          warnings.push('Skipped an undated Zap amount row that was not a fee or stamp duty.');
          continue;
        }
        if (date === null) {
          warnings.push('Skipped a Zap charge with no preceding transaction date.');
          continue;
        }
        pending = { date, description: narrative, amount, ...(running === null ? {} : { balance: running }) };
      } else if (pending && narrative && !/^(success|failed|pending|reversed)$/i.test(narrative)) {
        pending.description += `${pending.description ? ' ' : ''}${narrative}`;
      }
    }
  }
  flush();
  if (mismatches) warnings.push(`${mismatches} of ${rows.length} rows did not reconcile with the balance.`);
  return { rows, meta, warnings };
}

export const zapParser: PdfStatementParser = {
  name: 'zap',
  detect: (pages) => {
    const rows = clusterRows(pages[0] ?? []);
    const text = pageText(rows);
    return /\bzap\b/i.test(text) && /paystack/i.test(text) && header(rows) !== null;
  },
  parse: parseZap,
};
