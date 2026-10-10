// Tests for the layout-agnostic generic parser: it should read common layouts
// the tuned parsers don't, with correctly signed amounts. Pure positioned-item
// inputs, no pdf.js.

import { describe, expect, test } from 'bun:test';
import type { Item } from '../src/parsers/pdf-shared.js';
import { genericParser } from '../src/parsers/pdf-generic.js';
import { gtbankParser } from '../src/parsers/pdf-gtbank.js';
import { parsePdfItems } from '../src/parsers/pdf-core.js';

type Col = { label: string; x: number; w: number };

/** Build a single-page statement: a header row plus data rows, each cell placed
 *  at its column's x so centres align with the header seeds. Empty string = no
 *  cell in that column for that row. */
function page(cols: Col[], rows: string[][]): Item[][] {
	const items: Item[] = [];
	for (const c of cols) items.push({ text: c.label, x: c.x, y: 700, width: c.w });
	let y = 680;
	for (const r of rows) {
		r.forEach((text, i) => {
			if (text !== '') items.push({ text, x: cols[i].x, y, width: cols[i].w });
		});
		y -= 20;
	}
	return [items];
}

const DATE = { x: 50, w: 44 };
const DESC = { x: 120, w: 80 };
const C2 = { x: 320, w: 40 };
const C3 = { x: 400, w: 40 };
const BAL = { x: 470, w: 50 };

describe('genericParser.parse', () => {
	test('single signed Amount column', () => {
		const cols: Col[] = [
			{ label: 'Date', ...DATE },
			{ label: 'Description', ...DESC },
			{ label: 'Amount', ...C2 },
			{ label: 'Balance', ...BAL }
		];
		const result = genericParser.parse(
			page(cols, [
				['01/Feb/26', 'POS PURCHASE', '-5,000.00', '95,000.00'],
				['02/Feb/26', 'SALARY', '10,000.00', '105,000.00']
			])
		);
		expect(result.rows.map((r) => r.amount)).toEqual([-5000, 10000]);
		expect(result.rows.map((r) => r.balance)).toEqual([95000, 105000]);
	});

	test('Money Out / Money In columns', () => {
		const cols: Col[] = [
			{ label: 'Date', ...DATE },
			{ label: 'Description', ...DESC },
			{ label: 'Money Out', ...C2 },
			{ label: 'Money In', ...C3 },
			{ label: 'Balance', ...BAL }
		];
		const result = genericParser.parse(
			page(cols, [
				['01/Feb/26', 'POS', '5,000.00', '', '95,000.00'],
				['02/Feb/26', 'SALARY', '', '10,000.00', '105,000.00']
			])
		);
		expect(result.rows.map((r) => r.amount)).toEqual([-5000, 10000]);
	});

	test('Expense / Income columns', () => {
		const cols: Col[] = [
			{ label: 'Date', ...DATE },
			{ label: 'Description', ...DESC },
			{ label: 'Expense', ...C2 },
			{ label: 'Income', ...C3 },
			{ label: 'Balance', ...BAL }
		];
		const result = genericParser.parse(
			page(cols, [
				['01/Feb/26', 'POS', '5,000.00', '', '95,000.00'],
				['02/Feb/26', 'SALARY', '', '10,000.00', '105,000.00']
			])
		);
		expect(result.rows.map((r) => r.amount)).toEqual([-5000, 10000]);
	});

	test('Withdrawal / Deposit with Narration description', () => {
		const cols: Col[] = [
			{ label: 'Trans Date', ...DATE },
			{ label: 'Narration', ...DESC },
			{ label: 'Withdrawal', ...C2 },
			{ label: 'Deposit', ...C3 },
			{ label: 'Balance', ...BAL }
		];
		const result = genericParser.parse(
			page(cols, [
				['01/Feb/26', 'ATM CASH', '2,000.00', '', '98,000.00'],
				['02/Feb/26', 'REFUND', '', '500.00', '98,500.00']
			])
		);
		expect(result.rows.map((r) => r.amount)).toEqual([-2000, 500]);
		expect(result.rows.map((r) => r.description)).toEqual(['ATM CASH', 'REFUND']);
	});
});

describe('genericParser.detect', () => {
	const validHeader = page(
		[
			{ label: 'Date', ...DATE },
			{ label: 'Description', ...DESC },
			{ label: 'Amount', ...C2 },
			{ label: 'Balance', ...BAL }
		],
		[]
	);

	test('true for a recognisable header', () => {
		expect(genericParser.detect(validHeader)).toBe(true);
	});

	test('false when no header row is present', () => {
		const noHeader: Item[][] = [
			[
				{ text: 'Hello', x: 50, y: 700, width: 40 },
				{ text: 'World', x: 120, y: 700, width: 40 },
				{ text: 'foo bar baz', x: 50, y: 680, width: 80 }
			]
		];
		expect(genericParser.detect(noHeader)).toBe(false);
	});
});

describe('dispatch ordering', () => {
	const expenseIncome = page(
		[
			{ label: 'Date', ...DATE },
			{ label: 'Description', ...DESC },
			{ label: 'Expense', ...C2 },
			{ label: 'Income', ...C3 },
			{ label: 'Balance', ...BAL }
		],
		[
			['01/Feb/26', 'POS', '5,000.00', '', '95,000.00'],
			['02/Feb/26', 'SALARY', '', '10,000.00', '105,000.00']
		]
	);

	test('generic handles a layout the tuned GTBank parser rejects', () => {
		// GTBank only recognises Debit/Credit/Balance, so it must not match here…
		expect(gtbankParser.detect(expenseIncome)).toBe(false);
		expect(genericParser.detect(expenseIncome)).toBe(true);
		// …and the dispatcher falls through to the generic parser.
		expect(parsePdfItems(expenseIncome).rows.map((r) => r.amount)).toEqual([-5000, 10000]);
	});
});
