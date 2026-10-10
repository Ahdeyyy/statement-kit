/**
 * Draw fresh synthetic statements using the five reference layouts.
 * This generator imports neither a statement parser nor a reference PDF.
 * Expectations come from the randomly generated records before PDF authoring.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { StatementInfo, Transaction, BankName } from '../src/types.js';
import { makePdf, type FixtureText } from '../tests/fixtures/pdf.js';

const output = fileURLToPath(new URL('../tests/fixtures/statements/', import.meta.url));
const seedArgument = process.argv.indexOf('--seed');
const baseSeed = seedArgument < 0 ? 0x6fe28d91 : Number(process.argv[seedArgument + 1]);
if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffffffff) {
  throw new Error('--seed must be an unsigned 32-bit integer.');
}

type Layout = 'gtbank-rotated' | 'gtbank-short' | 'gtbank-landscape' | 'uba' | 'zenith';
type Spec = { id: Layout; bank: BankName; pages: number; rows: number; size: [number, number]; rotation: 0 | 90; features: string[] };
const specs: Spec[] = [
  { id: 'gtbank-rotated', bank: 'gtbank', pages: 98, rows: 1097, size: [595, 842], rotation: 90,
    features: ['rotated long-form', 'first-page-only header', 'wrapped references', 'description across page boundary'] },
  { id: 'gtbank-short', bank: 'gtbank', pages: 5, rows: 55, size: [595, 842], rotation: 0,
    features: ['portrait short-form', 'split header labels', 'wrapped dates', 'centered descriptions', 'reprinted boundary transaction'] },
  { id: 'gtbank-landscape', bank: 'gtbank', pages: 5, rows: 58, size: [842, 595], rotation: 0,
    features: ['upright landscape', 'centered headers with left-aligned data', 'masked account', 'Originating Branch', 'centered descriptions'] },
  { id: 'uba', bank: 'uba', pages: 7, rows: 65, size: [595, 842], rotation: 0,
    features: ['summary-only first page', 'three-row table header', 'masked account', 'centered narration', 'drawn table borders'] },
  { id: 'zenith', bank: 'zenith', pages: 13, rows: 465, size: [595, 842], rotation: 0,
    features: ['first-page-only header', 'credit and value date in one text run', 'zero-valued unused columns', 'wrapped descriptions'] },
];

// Seeded randomness makes failures reproducible; changing --seed changes every dataset.
function random(seed: number) {
  let state = seed >>> 0;
  return (min: number, max: number) => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    const unit = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    return min + Math.floor(unit * (max - min + 1));
  };
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');
const namedDate = (date: number) => { const d = new Date(date); return `${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
const numericDate = (date: number) => { const d = new Date(date); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const longDate = (date: number) => { const d = new Date(date); return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const money = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const width = (value: string, size: number) => [...value].reduce((sum, char) => sum + (/\d/.test(char) ? 0.556 : /[., ]/.test(char) ? 0.278 : 0.6) * size, 0);
const text = (value: string, x: number, y: number, fontSize: number): FixtureText => ({ text: value, x, y, fontSize, width: width(value, fontSize) });
const line = (x1: number, y1: number, x2: number, y2: number) => `0.7 G 0.25 w ${x1} ${y1} m ${x2} ${y2} l S`;
const shade = (x: number, y: number, w: number, h: number) => `0.94 g ${x} ${y} ${w} ${h} re f`;

type RecordToDraw = { transaction: Transaction; lines: string[]; referenceLines: string[] };
type Expected = { info: StatementInfo; transactions: Transaction[]; warnings: string[] };
type ManifestEntry = Spec & { seed: number; pdf: string; expected: string; pdfSha256: string; expectedSha256: string };

function makeDataset(spec: Spec, seed: number) {
  const choose = random(seed);
  const digits = (length: number) => Array.from({ length }, () => choose(0, 9)).join('');
  const token = (length: number) => Array.from({ length }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[choose(0, 23)]).join('');
  const syllables = ['ZA', 'MO', 'LI', 'KA', 'VE', 'NO', 'SU', 'BE', 'RO', 'TE'];
  const name = () => Array.from({ length: 2 }, () => Array.from({ length: 3 }, () => syllables[choose(0, syllables.length - 1)]).join('')).join(' ');
  const account = digits(10);
  const accountName = name();
  const branch = `${digits(3)} ${name()}`;
  const address = `${choose(10, 99)} ${token(6)} AVENUE`;
  const openingCents = choose(40_000_000, 80_000_000);
  let balanceCents = openingCents;
  let date = Date.UTC(choose(2030, 2038), choose(0, 11), choose(1, 20));
  const firstDate = date;
  const records: RecordToDraw[] = [];
  for (let index = 0; index < spec.rows; index++) {
    date += choose(0, 1) * 86_400_000;
    const amountCents = choose(101, 999_999) * (choose(0, 1) ? 1 : -1);
    balanceCents += amountCents;
    const lineCount = spec.id === 'gtbank-short' ? choose(2, 4)
      : spec.id === 'gtbank-landscape' ? choose(1, 3)
      : spec.id === 'uba' ? choose(2, 4) : choose(1, 3);
    // Random counterparty, terminal, reference and narrative values; all ASCII.
    const candidates = [
      `${amountCents < 0 ? 'PAYMENT' : 'TRANSFER'} ${name()}`,
      `REF ${digits(12)} ${token(4)}`,
      `FOR ${token(7)} ${digits(5)}`,
      `VIA ${token(5)} ${digits(8)}`,
    ];
    const lines = candidates.slice(0, lineCount);
    const referenceLines = spec.id === 'gtbank-short' ? [`${digits(13)}${token(3)}`]
      : [digits(16), `${digits(4)}${token(3)}`];
    const transaction: Transaction = { date, amount: amountCents / 100, balance: balanceCents / 100, description: lines.join(' ') };
    if (spec.bank === 'gtbank') transaction.reference = referenceLines.join(' ');
    records.push({ transaction, lines, referenceLines });
  }
  const displayName = spec.bank === 'gtbank' ? 'Guaranty Trust Bank (GTBank)'
    : spec.bank === 'uba' ? 'United Bank for Africa (UBA)' : 'Zenith Bank';
  const accountNumber = spec.id === 'gtbank-landscape' ? `${account.slice(0, 3)}XXXX${account.slice(-3)}`
    : spec.bank === 'uba' ? `${account.slice(0, 3)}xxxxx${account.slice(-2)}` : account;
  const lastDate = date;
  const period = spec.id === 'gtbank-short' ? `${longDate(firstDate)} - ${longDate(lastDate)}`
    : spec.bank === 'zenith' ? `${numericDate(firstDate)} TO ${numericDate(lastDate)}`
    : `${namedDate(firstDate)} - ${namedDate(lastDate)}`;
  const expected: Expected = {
    info: { bank: spec.bank, bankName: displayName, accountNumber, accountName, currency: 'NGN', openingBalance: openingCents / 100, period },
    transactions: records.map((record) => record.transaction), warnings: [],
  };
  return { expected, records, branch, address, firstDate, lastDate, account, closingBalance: balanceCents / 100 };
}

function distribute(total: number, pages: number, first: number): number[] {
  const remaining = total - first;
  return [first, ...Array.from({ length: pages - 1 }, (_, i) => Math.floor(remaining / (pages - 1)) + (i < remaining % (pages - 1) ? 1 : 0))];
}

function fitLines(records: RecordToDraw[], budget: number, leading: number, gap: number) {
  // Keep font size/leading intact, reducing narrative lines when a page is dense.
  let height = records.reduce((sum, record) => sum + record.lines.length * leading + gap, 0);
  for (let index = records.length - 1; height > budget; index = (index + records.length - 1) % records.length) {
    const record = records[index];
    if (record.lines.length > 1) {
      record.lines.pop();
      record.transaction.description = record.lines.join(' ');
      height -= leading;
    }
    if (records.every((record) => record.lines.length === 1) && height > budget) throw new Error('Page cannot fit its records.');
  }
}

function drawFixture(spec: Spec, seed: number): { pdf: Buffer; expected: Expected } {
  const dataset = makeDataset(spec, seed);
  const { expected, records } = dataset;
  const pages: FixtureText[][] = [];
  const commands: string[][] = [];
  const counts = spec.bank === 'uba' ? [0, ...distribute(spec.rows, spec.pages - 1, 11)]
    : distribute(spec.rows, spec.pages, spec.id === 'gtbank-rotated' ? 4 : spec.id === 'gtbank-landscape' ? 6 : spec.bank === 'zenith' ? 27 : 11);
  const debitTotal = records.reduce((sum, row) => sum + Math.max(0, -Math.round(row.transaction.amount * 100)), 0) / 100;
  const creditTotal = records.reduce((sum, row) => sum + Math.max(0, Math.round(row.transaction.amount * 100)), 0) / 100;
  let recordIndex = 0;
  let spill: { record: RecordToDraw; line: string } | undefined;
  for (let pageIndex = 0; pageIndex < spec.pages; pageIndex++) {
    const cells: FixtureText[] = [];
    const vectors: string[] = [];
    const put = (value: string, x: number, y: number, size = 8) => cells.push(text(value, x, y, size));
    const right = (value: string, edge: number, y: number, size = 8) => put(value, edge - width(value, size), y, size);
    const add = (value: string, x: number, y: number, size = 8) => put(value, x, y, size);
    const pageRecords = records.slice(recordIndex, recordIndex + counts[pageIndex]);
    recordIndex += pageRecords.length;
    const height = spec.rotation === 90 ? spec.size[0] : spec.size[1];
    put('SYNTHETIC TEST FIXTURE - NOT A REAL STATEMENT', spec.id === 'gtbank-landscape' ? 480 : 250, height - 12, 6);
    if (spec.id.startsWith('gtbank')) {
      if (spec.id === 'gtbank-short') {
        put('GTBank', 490, 794, 16); put('Customer Statement', 309.3, 793.4, 9);
        if (pageIndex === 0) {
          put(expected.info.accountName!, 43.7, 784.9, 14.6);
          for (const [label, value, x, valueX, y] of [
            ['Print Date:', longDate(dataset.lastDate + 86_400_000), 35.8, 84.1, 720.4],
            ['Address:', dataset.address, 261.6, 303.7, 720.4],
            ['Account No:', expected.info.accountNumber!, 35.8, 92.5, 699],
            ['Currency:', 'NGN', 261.6, 307.6, 699],
            ['Period:', expected.info.period!, 35.8, 70.1, 677.7],
            ['Opening Balance:', money(expected.info.openingBalance!), 261.6, 341.3, 677.7],
            ['Total Debit:', money(debitTotal), 35.8, 86.9, 656.3],
            ['Closing Balance:', money(dataset.closingBalance), 261.6, 337.9, 656.3],
            ['Branch Name:', dataset.branch, 35.8, 100.4, 635],
            ['Credit Count:', String(records.filter((r) => r.transaction.amount > 0).length), 261.6, 322.2, 635],
            ['Debit Count:', String(records.filter((r) => r.transaction.amount < 0).length), 35.8, 92.5, 613.7],
            ['Total Credit:', money(creditTotal), 261.6, 316, 613.7],
            ['Account Type:', 'SAVINGS', 261.6, 326.7, 592.3],
          ] as const) { put(label, x, y, 9); put(value, valueX, y, 9); }
        }
        const headerY = pageIndex === 0 ? 544 : 750;
        for (const [label, x] of [['Trans', 35.8], ['Reference', 86.4], ['Value', 189.1], ['Debit', 239.7], ['Credit', 303.1], ['Balance', 366.6], ['Remarks', 442.4]] as const) put(label, x, headerY, 7.3);
        put('Date', 35.8, headerY - 8.9, 7.3); put('Date', 189.1, headerY - 8.9, 7.3);
        vectors.push(shade(34, headerY - 15, 518, 25));
        let y = headerY - 43.2;
        const repeated = pageIndex === 1 ? records[counts[0] - 1] : undefined;
        const draw = repeated ? [repeated, ...pageRecords] : pageRecords;
        fitLines(draw, y - 50, 7.31, 14);
        for (const [rowIndex, record] of draw.entries()) {
          const row = record.transaction;
          const date = new Date(row.date);
          const shortDate = `${pad(date.getUTCDate())}${months[date.getUTCMonth()]}`;
          for (const x of [35.8, 189.1]) { put(shortDate, x, y + 3.94, 6.2); put(String(date.getUTCFullYear()), x, y - 3.37, 6.2); }
          put("'" + record.referenceLines[0], 86.4, y, 6.2);
          put(money(Math.abs(row.amount)), row.amount < 0 ? 239.7 : 303.1, y, 6.2);
          put(money(row.balance!), 366.6, y, 6.2);
          for (const [index, value] of record.lines.entries()) put(value, 442.4, y + (record.lines.length - 1) * 3.655 - index * 7.31, 6.2);
          vectors.push(line(34, y - record.lines.length * 3.655 - 5, 552, y - record.lines.length * 3.655 - 5));
          // Center each narrative inside its row even when neighboring rows
          // have different line counts, keeping text clear of the separator.
          const nextLineCount = draw[rowIndex + 1]?.lines.length ?? 1;
          y -= (record.lines.length + nextLineCount) * 3.655 + 14;
        }
      } else if (spec.id === 'gtbank-landscape') {
        if (pageIndex === 0) {
          const values = [['Statement Period', expected.info.period!], ['Branch Name', dataset.branch], ['Account No.', expected.info.accountNumber!], ['Internal Reference', `R${dataset.account.slice(0, 2)}XXXX${dataset.account.slice(-3)}`], ['Account Type', 'SAVINGS'], ['Currency', 'NIGERIAN NAIRA'], ['Opening Balance', money(expected.info.openingBalance!)]];
          values.forEach(([label, value], i) => { put(label, 25, 566.342 - i * 20, 9); put(value, 125, 566.342 - i * 20, 9); });
          put('CUSTOMER STATEMENT', 690.3, 458.8, 12); put(expected.info.accountName!, 621.9, 438.2, 18);
        }
        const headerY = pageIndex === 0 ? 409.552 : 560;
        for (const [label, x] of [['Trans. Date', 20.734], ['Value Date', 94.103], ['Reference', 176.733], ['Debits', 274.175], ['Credits', 363.169], ['Balance', 451.711], ['Originating Branch', 532.398], ['Remarks', 712.109]] as const) put(label, x, headerY, 8);
        vectors.push(shade(5, headerY - 5, 830, 16));
        let y = headerY - 28.12;
        fitLines(pageRecords, y - 40, 9.248, 14.248);
        for (const [r, record] of pageRecords.entries()) {
          const row = record.transaction;
          put(namedDate(row.date), 8, y); put(namedDate(row.date), 80.26, y);
          put("'" + record.referenceLines[0], 152.522, y + 4.624);
          put(record.referenceLines[1], 152.522, y - 4.624);
          right(money(Math.abs(row.amount)), row.amount < 0 ? 302.896 : 393.222, y);
          right(money(row.balance!), 485.772, y);
          put(dataset.branch, 513.826, y);
          const start = r % 2 === 0 ? y + (record.lines.length - 1) * 4.624 : y;
          record.lines.forEach((value, i) => put(value, 622.217, start - i * 9.248));
          y -= record.lines.length * 9.248 + 14.248;
        }
      } else {
        // Upright coordinates are transformed to a genuine /Rotate 90 page by makePdf.
        if (pageIndex === 0) {
          put(`Statement Period :${expected.info.period}`, 55, 523.8, 8);
          const values = [['Print. Date', namedDate(dataset.lastDate + 86_400_000)], ['Branch Name', dataset.branch], ['Account No', dataset.account], ['Internal Reference', `R${dataset.account.slice(0, 2)}XXXX${dataset.account.slice(-3)}`], ['Address', dataset.address], ['Account Type', 'SAVINGS'], ['Currency', 'NIGERIAN NAIRA'], ['Total Debit', money(debitTotal)], ['Total Credit', money(creditTotal)], ['Closing Balance', money(dataset.closingBalance)], ['Usable Balance', money(dataset.closingBalance)], ['Opening Balance', money(expected.info.openingBalance!)]];
          values.forEach(([label, value], i) => { put(label, 57, 493.8 - i * 18, 8); put(value, 134.7, 493.8 - i * 18, 8); });
          put('CUSTOMER STATEMENT', 641.7, 261.8, 12); put(expected.info.accountName!, 615.1, 240.8, 15);
          for (const [label, x] of [['Trans. Date', 53.1], ['Value. Date', 117.4], ['Reference', 181.8], ['Debits', 262.2], ['Credits', 342.6], ['Balance', 423], ['Originating Branch', 503.4], ['Remarks', 599.9]] as const) put(label, x, 205.8, 8);
          vectors.push(shade(50, 200, 738, 17));
        }
        let y = pageIndex === 0 ? 187.8 : 555;
        if (spill) { put(spill.line, 599.9, 575); spill = undefined; }
        fitLines(pageRecords, y - 42, 12, 12);
        for (const [index, record] of pageRecords.entries()) {
          const row = record.transaction;
          put(namedDate(row.date), 53.1, y); put(namedDate(row.date), 117.4, y);
          put("'" + record.referenceLines[0], 181.8, y); put(record.referenceLines[1], 181.8, y - 8);
          put(money(Math.abs(row.amount)), row.amount < 0 ? 262.2 : 342.6, y);
          put(money(row.balance!), 423, y); put(dataset.branch, 503.4, y);
          record.lines.forEach((value, i) => put(value, 599.9, y - i * 12));
          if (pageIndex === 0 && index === pageRecords.length - 1) {
            const continuation = `DETAIL ${record.referenceLines[0]}`;
            row.description += ' ' + continuation;
            spill = { record, line: continuation };
          }
          y -= record.lines.length * 12 + 12;
        }
      }
      put(`This is a computer generated synthetic test statement. Page: ${pageIndex + 1} of ${spec.pages}`, 55, 20, 6);
    } else if (spec.bank === 'uba') {
      put('UBA', 490, 789, 25);
      if (pageIndex === 0) {
        put(`Hello ${expected.info.accountName}!`, 40, 748, 26);
        put(`(${expected.info.period})`, 40, 710, 12);
        put('Account Statement', 238.8, 632, 18); put('Savings Account', 88, 620, 13);
        put(expected.info.accountNumber!, 88, 560.5, 20);
        for (const [label, value, y] of [['Currency:', 'Nigerian Naira', 607], ['Opening Balance:', money(expected.info.openingBalance!), 582], ['Total Debit:', money(debitTotal), 557], ['Total Credit:', money(creditTotal), 532], ['Closing Balance:', money(dataset.closingBalance), 507]] as const) { put(label, 238.8, y, 14); right(value, 550.5, y, 13); }
      } else {
        put(expected.info.accountName!, 40, 790, 15); put(`(${expected.info.period})`, 155, 772, 12);
        for (const [label, x, y] of [['TRANS', 37.3, 687], ['VALUE', 96.5, 687], ['CHQ.', 284.9, 687], ['NARRATION', 179.6, 682], ['DEBIT', 351.2, 682], ['CREDIT', 430.5, 682], ['BALANCE', 507.7, 682], ['DATE', 40.1, 677], ['DATE', 99.8, 677], ['NO', 290.1, 677]] as const) put(label, x, y, 10);
        vectors.push(shade(20, 670, 555, 28));
        let y = 620.5;
        if (pageIndex === 1) {
          put(namedDate(dataset.firstDate), 24.5, 655.5, 9); put(namedDate(dataset.firstDate), 84.2, 655.5, 9);
          put('Opening Balance', 143.8, 655.5, 9); right(money(expected.info.openingBalance!), 570.5, 655.5, 9);
        }
        fitLines(pageRecords, y - 55, 9, 15);
        for (const record of pageRecords) {
          const row = record.transaction;
          put(namedDate(row.date), 24.5, y, 9); put(namedDate(row.date - 86_400_000), 84.2, y, 9);
          right(money(Math.abs(row.amount)), row.amount < 0 ? 403.4 : 486.9, y, 9);
          right(money(row.balance!), 570.5, y, 9);
          const start = y + (record.lines.length - 1) * 4.5;
          record.lines.forEach((value, i) => put(value, 143.8, start - i * 9, 9));
          vectors.push(line(20, start + 12, 575, start + 12));
          y -= record.lines.length * 9 + 15;
        }
        for (const x of [20, 80, 140, 280, 318, 410, 494, 575]) vectors.push(line(x, y + 12, x, 698));
        vectors.push(line(20, y + 12, 575, y + 12));
      }
      put("Africa's global bank", 57, 28, 10.2);
      put(`Bank Statement - ${pageIndex + 1}`, 400, 28, 10.2);
    } else {
      if (pageIndex === 0) {
        put('ZENITH BANK PLC', 243.2, 690.4, 12);
        put(`ACCOUNT NAME: ${expected.info.accountName}`, 52, 657.9, 7); put('Account Statement', 250, 657.9, 7);
        put(dataset.address, 52, 647.5, 7); put(`Period: ${expected.info.period}`, 398.5, 647.5, 7);
        put('CURRENCY: NGN', 250, 637, 7); put(`ACCOUNT No.: ${dataset.account}`, 398.5, 637, 7);
        for (const [label, x] of [['DATE', 52], ['DESCRIPTION', 111.4], ['DEBIT', 264.9], ['CREDIT', 339.1], ['VALUE DATE', 413.4], ['BALANCE', 472.8]] as const) put(label, x, 603.6, 7);
        vectors.push(shade(50, 599, 495, 14));
        put('Opening Balance', 111.4, 592.6, 7); right('0.00', 335.1, 592.6, 7); right('0.00', 409.3, 592.6, 7); right(money(expected.info.openingBalance!), 543, 592.6, 7);
      }
      let y = pageIndex === 0 ? 581.6 : 783;
      fitLines(pageRecords, y - 45, 7, 4);
      for (const record of pageRecords) {
        const row = record.transaction;
        put(numericDate(row.date), 52, y, 7);
        right(row.amount < 0 ? money(-row.amount) : '0.00', 335.1, y, 7);
        const credit = row.amount > 0 ? money(row.amount) : '0.00';
        put(`${credit} ${numericDate(row.date)}`, 409.3 - width(credit, 7), y, 7);
        right(money(row.balance!), 543, y, 7);
        record.lines.forEach((value, i) => add(value, 111.4, y - i * 7, 7));
        y -= record.lines.length * 7 + 4;
      }
      put(`Page ${pageIndex + 1} of ${spec.pages}`, 52, 22, 7);
    }
    pages.push(cells); commands.push(vectors);
  }
  if (recordIndex !== records.length) throw new Error('Not all generated transactions were written.');
  const pdf = makePdf(pages, { rotate: spec.rotation === 90, pageSize: spec.size, pageCommands: commands });
  return { pdf, expected };
}

mkdirSync(output, { recursive: true });
const manifest: ManifestEntry[] = [];
for (const [index, spec] of specs.entries()) {
  const seed = (baseSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  const { pdf, expected } = drawFixture(spec, seed);
  const expectedText = JSON.stringify(expected, null, 2) + '\n';
  const pdfName = `${spec.id}.pdf`;
  const expectedName = `${spec.id}.expected.json`;
  writeFileSync(`${output}/${pdfName}`, pdf);
  writeFileSync(`${output}/${expectedName}`, expectedText);
  manifest.push({ ...spec, seed, pdf: pdfName, expected: expectedName,
    pdfSha256: createHash('sha256').update(pdf).digest('hex'),
    expectedSha256: createHash('sha256').update(expectedText).digest('hex') });
  console.log(`${spec.id}: ${spec.pages} pages, ${expected.transactions.length} transactions, seed ${seed}`);
}
writeFileSync(`${output}/manifest.json`, JSON.stringify({ version: 1, baseSeed, fixtures: manifest }, null, 2) + '\n');
