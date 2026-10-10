// Three-way comparison of the statement parsers on each bank's own layout,
// measuring how well the two layout-agnostic generic parsers stand in for the
// authoritative tuned parser:
//
//   1. tuned        — the per-bank parser (ground truth here).
//   2. text generic — `pdf-generic.ts`, columns inferred from word alignment and
//                     whitespace gutters (the original generic extractor).
//   3. lines generic— `pdf-generic-lines.ts`, columns/rows read off the table's
//                     drawn borders (the new lattice extractor).
//
// Each fixture carries both the positioned text (for tuned + text generic) and a
// full lattice of ruling lines (for the lines generic), so all three run on the
// same statement. Score = fraction of the tuned parser's rows each generic
// reproduces exactly (same signed amount, in order).
//
// Headline findings (asserted below):
//   - gtbank: all three tie at 1.0 — a clean single-row header both generics map
//             directly (text generic only since "value" was dropped as an amount
//             synonym; see pdf-generic-vs-tuned.ts).
//   - uba:    the lines generic LEADS — it recovers UBA's three-row split header
//             (each stacked label lands in one bordered cell), which the text
//             generic can't even detect (no single word-row carries both a date
//             and a description label).
//   - zenith: the lines generic TIES the text generic and both trail tuned — the
//             columns are clean either way, but Zenith glues a value date onto
//             the credit cell as one text run, which the shared parseAmount
//             rejects regardless of how the cell was found.

import { describe, expect, test } from 'bun:test';
import type { Item, Ruling } from '../src/parsers/pdf-shared.js';
import type { ParseResult } from '../src/parsers/types.js';
import { genericParser } from '../src/parsers/pdf-generic.js';
import { genericLinesParser } from '../src/parsers/pdf-generic-lines.js';
import { gtbankParser } from '../src/parsers/pdf-gtbank.js';
import { ubaParser } from '../src/parsers/pdf-uba.js';
import { zenithParser } from '../src/parsers/pdf-zenith.js';

function item(text: string, x: number, width: number, y: number): Item {
	return { text, x, y, width };
}

/** Full lattice of borders from column x-lines and row y-lines. */
function lattice(xs: number[], ys: number[]): Ruling[] {
	const left = Math.min(...xs);
	const right = Math.max(...xs);
	const bottom = Math.min(...ys);
	const top = Math.max(...ys);
	const rulings: Ruling[] = [];
	for (const y of ys) rulings.push({ x1: left, y1: y, x2: right, y2: y });
	for (const x of xs) rulings.push({ x1: x, y1: bottom, x2: x, y2: top });
	return rulings;
}

const amounts = (r: ParseResult) => r.rows.map((row) => row.amount);

/** Fraction of `truth`'s amounts reproduced exactly and in order by `got`. */
function score(got: number[], truth: number[]): number {
	if (truth.length === 0) return got.length === 0 ? 1 : 0;
	let ok = 0;
	for (let i = 0; i < truth.length; i++) if (got[i] === truth[i]) ok++;
	return ok / truth.length;
}

type Case = {
	bank: string;
	pages: Item[][];
	rulings: Ruling[][];
	tuned: ParseResult;
};

// ── gtbank: clean single-row header ──────────────────────────────────────────
const gtbank: Case = (() => {
	const H = [
		item('Trans Date', 50, 60, 700),
		item('Reference', 120, 70, 700),
		item('Value Date', 200, 60, 700),
		item('Debit', 280, 50, 700),
		item('Credit', 340, 50, 700),
		item('Balance', 400, 60, 700),
		item('Remarks', 470, 100, 700)
	];
	type Row = {
		date: string;
		ref: string;
		debit?: string;
		credit?: string;
		balance: string;
		remarks: string;
	};
	const dataRow = (r: Row, y: number): Item[] => {
		const items = [
			item(r.date, 50, 60, y),
			item(r.ref, 120, 70, y),
			item(r.balance, 400, 60, y),
			item(r.remarks, 470, 100, y)
		];
		if (r.debit) items.push(item(r.debit, 280, 50, y));
		if (r.credit) items.push(item(r.credit, 340, 50, y));
		return items;
	};
	const ROWS: Row[] = [
		{
			date: '01/Feb/26',
			ref: 'REF001',
			debit: '5,000.00',
			balance: '95,000.00',
			remarks: 'POS PURCHASE'
		},
		{
			date: '02/Feb/26',
			ref: 'REF002',
			credit: '10,000.00',
			balance: '105,000.00',
			remarks: 'SALARY'
		},
		{
			date: '03/Feb/26',
			ref: 'REF003',
			debit: '1,500.00',
			balance: '103,500.00',
			remarks: 'ATM WITHDRAWAL'
		}
	];
	const pages = [[...H, ...ROWS.flatMap((r, i) => dataRow(r, 680 - i * 20))]];
	const rulings = [lattice([45, 115, 195, 275, 335, 395, 465, 580], [710, 690, 670, 650, 630])];
	return { bank: 'gtbank', pages, rulings, tuned: gtbankParser.parse(pages) };
})();

// ── uba: header split across three stacked text rows ──────────────────────────
const uba: Case = (() => {
	const H = [
		item('Trans', 50, 30, 706),
		item('Value', 110, 30, 706),
		item('Chq', 320, 30, 706),
		item('Narration', 170, 100, 700),
		item('Debit', 340, 50, 700),
		item('Credit', 400, 50, 700),
		item('Balance', 460, 60, 700),
		item('Date', 50, 30, 694),
		item('Date', 110, 30, 694),
		item('No', 320, 30, 694)
	];
	const dataRow = (
		date: string,
		narr: string,
		debit: string,
		credit: string,
		bal: string,
		y: number
	): Item[] => {
		const items = [item(date, 50, 30, y), item(narr, 170, 100, y), item(bal, 460, 60, y)];
		if (debit) items.push(item(debit, 340, 50, y));
		if (credit) items.push(item(credit, 400, 50, y));
		return items;
	};
	const pages = [
		[
			...H,
			...dataRow('01-Feb-2026', 'POS PURCHASE', '5,000.00', '', '95,000.00', 680),
			...dataRow('02-Feb-2026', 'SALARY', '', '10,000.00', '105,000.00', 660)
		]
	];
	// One header band (688–712) encloses all three stacked label rows; columns
	// keep Chq No and Debit apart.
	const rulings = [lattice([45, 100, 160, 300, 350, 392, 455, 540], [712, 688, 670, 650])];
	return { bank: 'uba', pages, rulings, tuned: ubaParser.parse(pages) };
})();

// ── zenith: value date glued onto the credit cell ─────────────────────────────
const zenith: Case = (() => {
	const H = [
		item('Date', 50, 40, 700),
		item('Description', 100, 120, 700),
		item('Debit', 300, 60, 700),
		item('Credit', 380, 60, 700),
		item('Balance', 460, 70, 700)
	];
	const dataRow = (
		d: string,
		desc: string,
		deb: string,
		cr: string,
		bal: string,
		y: number
	): Item[] => [
		item(d, 50, 40, y),
		item(desc, 100, 120, y),
		item(deb, 300, 60, y),
		item(cr, 380, 60, y),
		item(bal, 460, 70, y)
	];
	const pages = [
		[
			...H,
			...dataRow('01/Feb/26', 'POS PURCHASE', '5,000.00', '0.00 01/02/2026', '95,000.00', 680),
			...dataRow('02/Feb/26', 'SALARY', '0.00', '10,000.00 02/02/2026', '105,000.00', 660)
		]
	];
	const rulings = [lattice([45, 95, 295, 375, 455, 540], [710, 690, 670, 650])];
	return { bank: 'zenith', pages, rulings, tuned: zenithParser.parse(pages) };
})();

const CASES = [gtbank, uba, zenith];

/** Score table, also logged so the comparison is visible when tests run. */
const results = CASES.map((c) => {
	const truth = amounts(c.tuned);
	const text = score(amounts(genericParser.parse(c.pages)), truth);
	const lines = score(amounts(genericLinesParser.parse(c.pages, c.rulings)), truth);
	return { bank: c.bank, rows: truth.length, text, lines };
});

describe('parser comparison: tuned vs text-generic vs lines-generic', () => {
	test('summary table (tuned is ground truth, scored 1.0 by definition)', () => {
		console.table(
			results.map((r) => ({
				bank: r.bank,
				rows: r.rows,
				tuned: 1,
				'text generic': r.text,
				'lines generic': r.lines
			}))
		);
		// Every bank has at least one row of ground truth to score against.
		expect(results.every((r) => r.rows > 0)).toBe(true);
	});

	test('gtbank: both generics fully reproduce the tuned output', () => {
		const r = results.find((x) => x.bank === 'gtbank')!;
		expect(r.text).toBe(1);
		expect(r.lines).toBe(1);
	});

	test('uba: the lines generic recovers the split header the text generic cannot', () => {
		const r = results.find((x) => x.bank === 'uba')!;
		expect(r.text).toBe(0); // text generic never even detects the table
		expect(r.lines).toBe(1); // lines generic matches tuned row for row
		expect(r.lines).toBeGreaterThan(r.text);
	});

	test('zenith: lines generic ties the text generic — both trail tuned on the glued value date', () => {
		const r = results.find((x) => x.bank === 'zenith')!;
		expect(r.lines).toBe(r.text);
		expect(r.lines).toBeLessThan(1); // the glued credit cell defeats both
		expect(r.lines).toBeGreaterThan(0); // but the debit row still matches
	});

	test('across the suite the lines generic never does worse than the text generic', () => {
		expect(results.every((r) => r.lines >= r.text)).toBe(true);
		// And on at least one bank it does strictly better.
		expect(results.some((r) => r.lines > r.text)).toBe(true);
	});
});
