// Draw a fresh Zap-shaped statement. No source file or customer data is read.
import { makePdf, type FixtureText } from '../tests/fixtures/pdf.js';
import type { StatementInfo, Transaction } from '../src/types.js';

export function drawZapFixture(seed: number) {
  let state = seed >>> 0;
  const choose = (min: number, max: number) => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return min + Math.floor(((value ^ (value >>> 14)) >>> 0) / 4294967296 * (max - min + 1));
  };
  const digits = (length: number) => Array.from({ length }, () => choose(0, 9)).join('');
  const token = () => Array.from({ length: 7 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[choose(0, 23)]).join('');
  const money = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateString = (value: number) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const periodDate = (value: number) => { const d = new Date(value); return `${d.getUTCDate()} ${dateString(value).slice(0, 3)} ${d.getUTCFullYear()}`; };
  const start = Date.UTC(choose(2030, 2038), choose(0, 5), choose(1, 15));
  const period = `${periodDate(start)} - ${periodDate(start + 180 * 86400000)}`;
  const opening = choose(40_000_000, 80_000_000);
  const info: StatementInfo = { bank: 'zap', bankName: 'Zap by Paystack', accountName: `${token()} ${token()}`,
    accountNumber: digits(10), currency: 'NGN', openingBalance: opening / 100, period };
  let balance = opening;
  let date = start;
  const transactions: Transaction[] = [];
  type Entry = { transaction: Transaction; lines: string[]; type: string[]; source: string; time: string; charges: Transaction[] };
  const entries: Entry[] = [];
  for (let i = 0; i < 15; i++) {
    date += choose(1, 9) * 86400000;
    const topup = [0, 5, 13].includes(i);
    const bill = [3, 4, 6, 11].includes(i);
    const external = i === 4;
    const lines = topup ? [`Topup from ${token()}`, `${token()}/Example Bank/NIP`, `Transfer ${token()}...`]
      : bill ? [`${i % 2 ? 'Airtime' : 'Data'}-${token()}`]
      : [`Transfer to ${token()} ${token()} -`, digits(30), `Purchase ${token()}...`];
    const amount = choose(101, 2_999_999) * (topup ? 1 : -1);
    if (!external) balance += amount;
    const transaction: Transaction = { date, description: lines.join(' '), amount: amount / 100,
      ...(external ? {} : { balance: balance / 100 }) };
    transactions.push(transaction);
    const charges: Transaction[] = [];
    if (!topup && !bill) {
      const fees = [choose(101, 4999), ...(i === 1 ? [choose(5001, 9999)] : [])];
      for (const [index, fee] of fees.entries()) {
        balance -= fee;
        const charge: Transaction = { date, description: index === 0 ? 'Fee - TRANSFER' : 'Stamp Duty', amount: -fee / 100, balance: balance / 100 };
        charges.push(charge); transactions.push(charge);
      }
    }
    entries.push({ transaction, lines, charges, type: topup ? ['TOPUP'] : bill ? ['BILL', 'PAYMENT'] : ['TRANSFER'],
      source: topup ? 'Inward Transfer' : external ? 'Bank Account' : 'Zap Balance',
      time: `${String(choose(1, 12)).padStart(2, '0')}:${String(choose(0, 59)).padStart(2, '0')} ${choose(0, 1) ? 'AM' : 'PM'}` });
  }
  const pages: FixtureText[][] = [];
  const pageCommands: string[][] = [];
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    const items: FixtureText[] = [];
    // Approximate Helvetica advances, sufficient for right-aligned fixture text.
    const width = (value: string, size: number) => [...value].reduce((sum, ch) => sum + (/[., :]/.test(ch) ? 0.278 : /[0-9]/.test(ch) ? 0.556 : 0.6) * size, 0);
    const put = (text: string, x: number, y: number, fontSize = 8.5) => items.push({ text, x, y, fontSize, width: width(text, fontSize) });
    const right = (text: string, edge: number, y: number, size = 8.5) => put(text, edge - width(text, size), y, size);
    put('SYNTHETIC TEST FIXTURE - NOT A REAL STATEMENT', 42.5, 827, 7);
    put('Zap', 42.5, 791.9, 24); put('Powered by Paystack', 42.5, 765.6, 8.5);
    right(`Statement of Account${pageIndex ? ' (Cont.)' : ''}`, 554, 794, 13);
    const x = pageIndex ? 340.7 : 358.2;
    for (const [index, [label, value]] of [ ['Account Name:', info.accountName!], ['Account Number:', info.accountNumber!],
      ['Bank:', 'Example Partner Bank'], ['Period:', period] ].entries()) {
      put(label, x, 773 - index * 13, 8); right(value, 554, 773 - index * 13, 8);
    }
    if (!pageIndex) {
      const incoming = transactions.reduce((sum, t) => sum + Math.max(0, Math.round(t.amount * 100)), 0) / 100;
      // External payments do not contribute to the wallet's summary totals.
      const outgoing = transactions.reduce((sum, t) => sum + (t.balance === undefined ? 0 : Math.max(0, -Math.round(t.amount * 100))), 0) / 100;
      for (const [label, value, column] of [ ['OPENING BALANCE', `\u20a6${money(opening / 100)}`, 58.3],
        ['MONEY IN', `+ \u20a6${money(incoming)}`, 181], ['MONEY OUT', `- \u20a6${money(outgoing)}`, 303.7],
        ['CLOSING BALANCE', `\u20a6${money(balance / 100)}`, 442.2] ] as const) {
        put(label, column, 683.1, 8); put(value, column, 668.1, 9);
      }
    }
    const headerY = pageIndex ? 697.4 : 619.4;
    for (const [label, column] of [['DATE', 43.3], ['DESCRIPTION', 109.7], ['TYPE', 293.8], ['SOURCE', 344.9], ['AMOUNT', 442], ['BALANCE', 511.3]] as const) put(label, column, headerY, 8);
    const commands = [`0.94 g 42.5 ${headerY - 9} 512 24 re f`];
    let y = headerY - 28.5;
    for (const entry of entries.slice(pageIndex ? 8 : 0, pageIndex ? 15 : 8)) {
      const t = entry.transaction;
      put(dateString(t.date), 42.5, y, 8); put(entry.time, 42.5, y - 9.75, 7);
      entry.lines.forEach((line, i) => put(line, 109, y - i * 10.5, 8));
      entry.type.forEach((line, i) => put(line, 293, y + 1.5 - i * 8.25, 7));
      put(entry.source, 344.1, y, 8);
      right(`${t.amount >= 0 ? '+' : '-'}${money(Math.abs(t.amount))}`, 482.2, y);
      if (t.balance !== undefined) right(`\u20a6${money(t.balance)}`, 553.8, y);
      const bottom = y - (entry.lines.length - 1) * 10.5;
      put('SUCCESS', 117.2, bottom - 12.8, 7);
      y = bottom - 37;
      for (const charge of entry.charges) {
        put(charge.description, 116.5, y, 8); right(`-${money(-charge.amount)}`, 482.2, y + 0.75);
        right(`\u20a6${money(charge.balance!)}`, 553.8, y); y -= 18;
      }
      commands.push(`0.8 G 0.3 w 42.5 ${y + 9} m 554 ${y + 9} l S`);
    }
    put('Important Notice:', 42.5, 36.6, 6);
    put('This is a digitally generated statement. Zap by Paystack is not a bank.', 104.5, 36.6, 6);
    put('Banking services are provided by our banking partners.', 42.5, 30.6, 6);
    right(`Generated on - ${periodDate(start + 181 * 86400000)}`, 554, 48.6, 6);
    right(`Page ${pageIndex + 1} of 2`, 554, 36.6, 6);
    if (y < 65) throw new Error('Zap fixture rows overlap the footer.');
    pages.push(items); pageCommands.push(commands);
  }
  return { pdf: makePdf(pages, { pageSize: [595.91998, 842.88], pageCommands }), expected: { info, transactions, warnings: [] as string[] } };
}
