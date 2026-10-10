// Unit tests for the lattice/"lines" table extractor. Builds positioned text
// items plus the vector ruling lines that border them, staying free of pdf.js —
// same pure-function style as pdf-table.test.ts (the text/gutter sibling).

import { describe, expect, test } from 'bun:test';
import type { Item, Ruling } from '../src/parsers/pdf-shared.js';
import {
	splitRulings,
	gridLines,
	pageToGridByLines,
	extractTableByLines
} from '../src/parsers/pdf-table-lines.js';

function item(text: string, x: number, width: number, y: number): Item {
	return { text, x, y, width };
}

/** Build a full lattice of borders from column x-positions and row y-positions:
 *  one horizontal rule per row line spanning all columns, one vertical rule per
 *  column line spanning all rows. */
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

// Columns Date|Description|Debit|Credit|Balance and three row bands (a header
// band and two data bands). Numerics are right-aligned within their column, as
// statements print them.
const COL_X = [40, 110, 280, 360, 440, 540];
const ROW_Y = [710, 690, 670, 650];
const BORDERS = lattice(COL_X, ROW_Y);

const TABLE: Item[] = [
	item('Date', 45, 30, 695),
	item('Description', 115, 70, 695),
	item('Debit', 290, 40, 695),
	item('Credit', 370, 40, 695),
	item('Balance', 450, 50, 695),
	// Row 1: a debit.
	item('01/Feb/26', 45, 50, 675),
	item('POS PURCHASE', 115, 90, 675),
	item('5,000.00', 310, 45, 675),
	item('95,000.00', 455, 55, 675),
	// Row 2: a credit.
	item('02/Feb/26', 45, 50, 655),
	item('SALARY', 115, 50, 655),
	item('10,000.00', 385, 50, 655),
	item('105,000.00', 450, 60, 655)
];

describe('splitRulings', () => {
	test('classifies axis-aligned rules and drops short/diagonal ones', () => {
		const { horizontals, verticals } = splitRulings([
			{ x1: 40, y1: 700, x2: 540, y2: 700 }, // horizontal
			{ x1: 40, y1: 650, x2: 40, y2: 710 }, // vertical
			{ x1: 40, y1: 650, x2: 200, y2: 710 }, // diagonal → dropped
			{ x1: 40, y1: 700, x2: 45, y2: 700 } // too short → dropped
		]);
		expect(horizontals).toHaveLength(1);
		expect(verticals).toHaveLength(1);
		expect(horizontals[0].pos).toBe(700);
		expect(verticals[0].pos).toBe(40);
	});
});

describe('gridLines', () => {
	test('collapses near-equal rule positions into one line each', () => {
		const lines = [
			{ pos: 100, lo: 0, hi: 1 },
			{ pos: 101, lo: 0, hi: 1 }, // within tolerance of 100
			{ pos: 200, lo: 0, hi: 1 }
		];
		expect(gridLines(lines)).toEqual([100.5, 200]);
	});
});

describe('pageToGridByLines', () => {
	test('reads cells straight off the borders, keeping right-aligned numerics', () => {
		expect(pageToGridByLines(TABLE, BORDERS)).toEqual([
			['Date', 'Description', 'Debit', 'Credit', 'Balance'],
			['01/Feb/26', 'POS PURCHASE', '5,000.00', '', '95,000.00'],
			['02/Feb/26', 'SALARY', '', '10,000.00', '105,000.00']
		]);
	});

	test('ignores items outside the table and yields nothing without a grid', () => {
		const withMargin = [...TABLE, item('Page 1 of 2', 560, 60, 620)];
		// The margin note sits right of the last column line, so it is dropped.
		expect(pageToGridByLines(withMargin, BORDERS)).toHaveLength(3);
		// No rules → no grid.
		expect(pageToGridByLines(TABLE, [])).toEqual([]);
	});
});

describe('extractTableByLines', () => {
	test('produces a header-led grid for a Debit/Credit/Balance layout', () => {
		const { grid, headerRowIndex } = extractTableByLines([TABLE], [BORDERS]);
		expect(headerRowIndex).toBe(0);
		expect(grid).toEqual([
			['Date', 'Description', 'Debit', 'Credit', 'Balance'],
			['01/Feb/26', 'POS PURCHASE', '5,000.00', '', '95,000.00'],
			['02/Feb/26', 'SALARY', '', '10,000.00', '105,000.00']
		]);
	});

	test('drops reprinted header rows on later pages', () => {
		const { grid } = extractTableByLines([TABLE, TABLE], [BORDERS, BORDERS]);
		expect(grid.filter((r) => r[0] === 'Date')).toHaveLength(1);
		// 1 header + 2 data rows per page × 2 pages.
		expect(grid).toHaveLength(5);
	});
});
