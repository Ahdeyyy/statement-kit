// Unit tests for the generic table extractor. Operates on hand-built positioned
// items ({text,x,y,width}) so it stays free of pdf.js — same pure-function style
// as telegram.test.ts.

import { describe, expect, test } from 'bun:test';
import { clusterRows, type Item } from '../src/parsers/pdf-shared.js';
import {
	detectColumns,
	detectColumnsByGutters,
	extractTable,
	rowsToGrid
} from '../src/parsers/pdf-table.js';

function item(text: string, x: number, width: number, y: number): Item {
	return { text, x, y, width };
}

// A clean Date | Description | Debit | Credit | Balance header. Centres:
// Date 60, Description 150, Debit 340, Credit 420, Balance 500 → midpoint seps.
const HEADER: Item[] = [
	item('Date', 50, 20, 700),
	item('Description', 120, 60, 700),
	item('Debit', 320, 40, 700),
	item('Credit', 400, 40, 700),
	item('Balance', 480, 40, 700)
];

describe('detectColumns (header-anchored)', () => {
	test('recovers column separators from a clean header row', () => {
		expect(detectColumns(clusterRows(HEADER))).toEqual([105, 245, 380, 460]);
	});
});

describe('detectColumnsByGutters (whitespace fallback)', () => {
	test('finds separators from blank channels when no header is present', () => {
		const rows = clusterRows([
			item('A', 50, 30, 680),
			item('B', 120, 40, 680),
			item('C', 300, 50, 680),
			item('D', 55, 20, 660),
			item('E', 130, 25, 660),
			item('F', 310, 30, 660)
		]);
		expect(detectColumnsByGutters(rows)).toEqual([100, 230]);
	});
});

describe('rowsToGrid', () => {
	const seps = [105, 245, 380, 460];

	test('joins wrapped multi-fragment cells and keeps right-aligned numerics', () => {
		const rows = clusterRows([
			item('POS', 120, 20, 680),
			item('PURCHASE', 145, 50, 680),
			item('500.00', 470, 40, 680)
		]);
		expect(rowsToGrid(rows, seps)[0]).toEqual(['', 'POS PURCHASE', '', '', '500.00']);
	});
});

describe('extractTable', () => {
	test('produces a header-led grid for a Debit/Credit/Balance layout', () => {
		const pages: Item[][] = [
			[
				...HEADER,
				// Row 1: a debit.
				item('01/Feb/26', 50, 44, 680),
				item('POS PURCHASE', 120, 80, 680),
				item('5,000.00', 320, 40, 680),
				item('95,000.00', 470, 50, 680),
				// Row 2: a credit.
				item('02/Feb/26', 50, 44, 660),
				item('SALARY', 120, 50, 660),
				item('10,000.00', 400, 40, 660),
				item('105,000.00', 465, 55, 660)
			]
		];
		const { grid, headerRowIndex } = extractTable(pages);
		expect(headerRowIndex).toBe(0);
		expect(grid).toEqual([
			['Date', 'Description', 'Debit', 'Credit', 'Balance'],
			['01/Feb/26', 'POS PURCHASE', '5,000.00', '', '95,000.00'],
			['02/Feb/26', 'SALARY', '', '10,000.00', '105,000.00']
		]);
	});

	test('drops reprinted header rows on later pages', () => {
		const dataRow = (y: number): Item[] => [
			item('03/Feb/26', 50, 44, y),
			item('TRANSFER', 120, 60, y),
			item('1,000.00', 320, 40, y),
			item('94,000.00', 470, 50, y)
		];
		const pages: Item[][] = [
			[...HEADER, ...dataRow(680)],
			[...HEADER, ...dataRow(680)] // page 2 reprints the header
		];
		const { grid } = extractTable(pages);
		// One header row only; the two data rows follow.
		expect(grid.filter((r) => r[0] === 'Date')).toHaveLength(1);
		expect(grid).toHaveLength(3);
	});
});
