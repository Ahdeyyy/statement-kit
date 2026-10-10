// GTBank landscape long-form statement (the variant with an "Originating Branch"
// column, printed upright on a wide page). It differs from the single-row
// short-form fixture in three ways that each broke the parser before:
//
//   1. Header labels are centred over wide columns while the data is left-aligned,
//      so "Reference" / "Remarks" data sits well LEFT of its header label. A tight
//      header-hugging left edge missed it, leaving references and descriptions
//      blank.
//   2. A description is a multi-line block CENTRED on its balance row, so some of
//      its lines sit ABOVE the balance line. Attaching each line to the nearest
//      anchor at-or-above it stole those top lines to the previous record; the
//      parser now groups fragments into per-record blocks by vertical spacing.
//   3. An "Originating Branch" name ("472 MOVA ALAMARO") sits between the balance
//      and remarks columns and must not be read as an amount or a remark.
//
// Geometry (x/width/y) mirrors a real statement so the boundaries are exercised
// faithfully.

import { describe, expect, test } from 'bun:test';
import type { Item } from '../src/parsers/pdf-shared.js';
import { gtbankParser } from '../src/parsers/pdf-gtbank.js';

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

// Account-information block above the table, right-hand "CUSTOMER STATEMENT"
// caption, and the account holder — with an "Opening Balance" line sorting
// between the caption and the name (the reason a naive "next line" grab failed).
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
	transDate: string;
	valueDate: string;
	refs: Line[];
	debit?: { text: string; x: number; width: number };
	credit?: { text: string; x: number; width: number };
	balance: string;
	balanceY: number;
	branch: string;
	desc: Line[];
};

function rowItems(t: Txn): Item[] {
	const items: Item[] = [
		item(t.transDate, 8, 44.9, t.balanceY),
		item(t.valueDate, 80.3, 44.9, t.balanceY),
		item(t.balance, 450.2, 35.6, t.balanceY),
		item(t.branch, 513.8, 74.3, t.balanceY)
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
		transDate: '01-Jun-2026',
		valueDate: '01-Jun-2026',
		refs: [{ text: "'8724936150AIR", y: 381.4 }],
		debit: { text: '3,000.00', x: 271.8, width: 31.1 },
		balance: '59,114.29',
		balanceY: 381.4,
		branch: '472 MOVA ALAMARO',
		desc: [
			{ text: 'Airtime Purchase VIA AIRTIME VIA GTWORLD', y: 395.3 },
			{ text: '101CT0000000008724936150-2348072591463-DATA', y: 386.1 },
			{ text: 'FROM VEKAZA MOSULIVENZA TO AIRTEL AIRTIME', y: 376.8 },
			{ text: 'COLLECTION SALE', y: 367.6 }
		]
	},
	{
		// Description starts on the balance row and wraps downward.
		transDate: '01-Jun-2026',
		valueDate: '01-Jun-2026',
		refs: [{ text: "'9305728614AIR", y: 353.3 }],
		debit: { text: '500.00', x: 276.2, width: 24.5 },
		balance: '58,614.29',
		balanceY: 353.3,
		branch: '472 MOVA ALAMARO',
		desc: [
			{ text: 'Airtime Purchase VIA AIRTIME VIA GTWORLD', y: 353.3 },
			{ text: '101CT0000000009305728614-2348072591463-DATA', y: 344.1 },
			{ text: 'FROM VEKAZA MOSULIVENZA TO AIRTEL AIRTIME', y: 334.8 },
			{ text: 'COLLECTION SALE', y: 325.6 }
		]
	},
	{
		// A credit whose description again has a line above the balance row — the
		// regression: it must attach here, not to the record above.
		transDate: '02-Jun-2026',
		valueDate: '02-Jun-2026',
		refs: [
			{ text: "'794512806137492058", y: 306.7 },
			{ text: '13GTW', y: 297.4 }
		],
		credit: { text: '5,000.00', x: 362.1, width: 31.1 },
		balance: '63,614.29',
		balanceY: 302.1,
		branch: '472 MOVA ALAMARO',
		desc: [
			{ text: 'TRANSFER BETWEEN CUSTOMERS VIA GTWORLD', y: 311.3 },
			{ text: 'PAYMENT FOR FUEL. FROM VEKAZA ZAVEROMO', y: 302.1 },
			{ text: 'BEMONZA TO VEKAZA MOSULIVENZ', y: 292.8 }
		]
	}
];

const pages: Item[][] = [[...META, ...HEADER, ...TXNS.flatMap(rowItems)]];
const result = gtbankParser.parse(pages);

describe('gtbank landscape long-form (Originating Branch) parser', () => {
	test('detects the layout', () => {
		expect(gtbankParser.detect(pages)).toBe(true);
	});

	test('reads amounts and running balances (branch names are not amounts)', () => {
		expect(result.warnings).toEqual([]);
		expect(result.rows.map((r) => r.amount)).toEqual([-3000, -500, 5000]);
		expect(result.rows.map((r) => r.balance)).toEqual([59114.29, 58614.29, 63614.29]);
	});

	test('extracts references despite left-aligned data under a right-shifted label', () => {
		expect(result.rows.map((r) => r.reference)).toEqual([
			'8724936150AIR',
			'9305728614AIR',
			'794512806137492058 13GTW'
		]);
	});

	test('assembles each multi-line, row-centred description under the right record', () => {
		expect(result.rows[0].description).toBe(
			'Airtime Purchase VIA AIRTIME VIA GTWORLD ' +
				'101CT0000000008724936150-2348072591463-DATA ' +
				'FROM VEKAZA MOSULIVENZA TO AIRTEL AIRTIME COLLECTION SALE'
		);
		// The line above this record's balance row ("TRANSFER BETWEEN CUSTOMERS…")
		// must belong to it, not to the record above.
		expect(result.rows[2].description).toBe(
			'TRANSFER BETWEEN CUSTOMERS VIA GTWORLD ' +
				'PAYMENT FOR FUEL. FROM VEKAZA ZAVEROMO BEMONZA TO VEKAZA MOSULIVENZ'
		);
	});

	test('reads the account holder, skipping the intervening Opening Balance line', () => {
		expect(result.meta.accountName).toBe('VEKAZA MOSULIVENZA');
		expect(result.meta.currency).toBe('NGN');
		expect(result.meta.openingBalance).toBe(62114.29);
	});
});
