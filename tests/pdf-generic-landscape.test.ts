// The generic (text/gutter) parser on a GTBank-style landscape long-form layout,
// where one transaction spans several visual rows: its description wraps across
// lines that are vertically offset from — and centred on — the row carrying the
// date and amount, and its reference is split across two lines. The plain
// one-visual-row-per-record mapping lost the descriptions and split the
// references; `extractTable` now folds each multi-row record into a single grid
// row. Metadata rows above the table (which sort between the "CUSTOMER STATEMENT"
// caption and the first transaction) must not skew the block-splitting or merge
// into a transaction.
//
// The tuned GTBank parser owns this layout in production; this pins the generic
// fallback's behaviour on the same shape for any other bank that prints it.

import { describe, expect, test } from 'bun:test';
import type { Item } from '../src/parsers/pdf-shared.js';
import { extractTable } from '../src/parsers/pdf-table.js';
import { genericParser } from '../src/parsers/pdf-generic.js';

/** item(text, x, width, y) — matches the other parser fixtures' convention. */
function item(text: string, x: number, width: number, y: number): Item {
	return { text, x, y, width };
}

const HEADER: Item[] = [
	item('Trans. Date', 20.7, 41.8, 409.6),
	item('Value Date', 94.1, 39.6, 409.6),
	item('Reference', 176.7, 36.9, 409.6),
	item('Debits', 274.2, 22.7, 409.6),
	item('Credits', 363.2, 25.3, 409.6),
	item('Balance', 451.7, 28.9, 409.6),
	item('Originating Branch', 532.4, 66.2, 409.6),
	item('Remarks', 712.1, 32, 409.6)
];

// Account-information block above the table. "Opening Balance" is dropped as
// noise; "Currency…", "CUSTOMER STATEMENT" and the account holder pass through as
// non-transaction rows and must not merge into the first record.
const META: Item[] = [
	item('Currency', 25, 39.5, 466.3),
	item('NIGERIAN NAIRA', 125, 75, 466.3),
	item('CUSTOMER STATEMENT', 690.3, 144.7, 458.8),
	item('Opening Balance', 25, 73.5, 446.3),
	item('62,114.29', 125, 40, 446.3),
	item('VEKAZA MOSULIVENZA', 621.9, 213.1, 438.2)
];

type Line = { text: string; y: number };
type Txn = {
	date: string;
	refs: Line[];
	debit?: { text: string; x: number; width: number };
	credit?: { text: string; x: number; width: number };
	balance: string;
	balanceY: number;
	desc: Line[];
};

function rowItems(t: Txn): Item[] {
	const items: Item[] = [
		item(t.date, 8, 44.9, t.balanceY),
		item(t.date, 80.3, 44.9, t.balanceY),
		item(t.balance, 450.2, 35.6, t.balanceY),
		item('472 MOVA ALAMARO', 513.8, 74.3, t.balanceY)
	];
	for (const r of t.refs) items.push(item(r.text, 152.5, 60, r.y));
	for (const d of t.desc) items.push(item(d.text, 622.2, 180, d.y));
	if (t.debit) items.push(item(t.debit.text, t.debit.x, t.debit.width, t.balanceY));
	if (t.credit) items.push(item(t.credit.text, t.credit.x, t.credit.width, t.balanceY));
	return items;
}

const TXNS: Txn[] = [
	{
		// Description straddles the balance row (two lines above, two below).
		date: '01-Jun-2026',
		refs: [{ text: "'8724936150AIR", y: 381.4 }],
		debit: { text: '3,000.00', x: 271.8, width: 31.1 },
		balance: '59,114.29',
		balanceY: 381.4,
		desc: [
			{ text: 'Airtime Purchase VIA AIRTIME VIA GTWORLD', y: 395.3 },
			{ text: '101CT0000000008724936150-2348072591463-DATA', y: 386.1 },
			{ text: 'FROM VEKAZA MOSULIVENZA TO AIRTEL AIRTIME', y: 376.8 },
			{ text: 'COLLECTION SALE', y: 367.6 }
		]
	},
	{
		// Description starts on the balance row and wraps downward.
		date: '01-Jun-2026',
		refs: [{ text: "'9305728614AIR", y: 353.3 }],
		debit: { text: '500.00', x: 276.2, width: 24.5 },
		balance: '58,614.29',
		balanceY: 353.3,
		desc: [
			{ text: 'Airtime Purchase VIA AIRTIME VIA GTWORLD', y: 353.3 },
			{ text: '101CT0000000009305728614-2348072591463-DATA', y: 344.1 },
			{ text: 'FROM VEKAZA MOSULIVENZA TO AIRTEL AIRTIME', y: 334.8 },
			{ text: 'COLLECTION SALE', y: 325.6 }
		]
	},
	{
		// A credit whose description has a line above the balance row and whose
		// reference is split across two lines straddling it.
		date: '02-Jun-2026',
		refs: [
			{ text: "'794512806137492058", y: 306.7 },
			{ text: '13GTW', y: 297.4 }
		],
		credit: { text: '5,000.00', x: 362.1, width: 31.1 },
		balance: '63,614.29',
		balanceY: 302.1,
		desc: [
			{ text: 'TRANSFER BETWEEN CUSTOMERS VIA GTWORLD', y: 311.3 },
			{ text: 'PAYMENT FOR FUEL. FROM VEKAZA ZAVEROMO', y: 302.1 },
			{ text: 'BEMONZA TO VEKAZA MOSULIVENZ', y: 292.8 }
		]
	}
];

const pages: Item[][] = [[...META, ...HEADER, ...TXNS.flatMap(rowItems)]];

describe('generic parser: landscape multi-row records', () => {
	test('folds each transaction into exactly one grid row', () => {
		const { grid, headerRowIndex } = extractTable(pages);
		expect(headerRowIndex).toBe(0);
		// Header + three transaction rows + the three passthrough metadata rows
		// (Currency…, CUSTOMER STATEMENT, VEKAZA…), none of which merged into a
		// transaction. The transaction rows each carry their full description.
		const txnRows = grid.filter((r) => /Jun-2026/.test(r.join(' ')));
		expect(txnRows).toHaveLength(3);
		expect(txnRows[0]).toEqual([
			'01-Jun-2026',
			'01-Jun-2026',
			"'8724936150AIR",
			'3,000.00',
			'',
			'59,114.29',
			'472 MOVA ALAMARO',
			'Airtime Purchase VIA AIRTIME VIA GTWORLD ' +
				'101CT0000000008724936150-2348072591463-DATA ' +
				'FROM VEKAZA MOSULIVENZA TO AIRTEL AIRTIME COLLECTION SALE'
		]);
	});

	test('parses amounts, balances, merged references and descriptions', () => {
		const result = genericParser.parse(pages);
		expect(result.rows.map((r) => r.amount)).toEqual([-3000, -500, 5000]);
		expect(result.rows.map((r) => r.balance)).toEqual([59114.29, 58614.29, 63614.29]);
		expect(result.rows.map((r) => r.reference)).toEqual([
			'8724936150AIR',
			'9305728614AIR',
			'794512806137492058 13GTW'
		]);
		// The line above this record's balance row must belong to it, not the record
		// above.
		expect(result.rows[2].description).toBe(
			'TRANSFER BETWEEN CUSTOMERS VIA GTWORLD ' +
				'PAYMENT FOR FUEL. FROM VEKAZA ZAVEROMO BEMONZA TO VEKAZA MOSULIVENZ'
		);
	});
});
