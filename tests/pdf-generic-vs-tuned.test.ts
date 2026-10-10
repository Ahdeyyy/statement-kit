// Cross-checks the layout-agnostic generic parser against each tuned
// per-bank parser on that bank's *own* statement layout, to measure how well
// the generic fallback would have done had it run instead. Fixtures mirror
// the column layouts documented at the top of each pdf-<bank>.ts file. Pure
// positioned-item inputs (no pdf.js), same style as pdf-generic.test.ts.
//
// Headline result: the generic parser fully reproduces the tuned parser's
// output on one of the four banks (gtbank), and falls short on the other three:
//   - gtbank: fully reproduced. Its single-row header (Remarks reads as the
//     description, Debit/Credit/Balance map directly) is exactly what the
//     generic parser handles. This only holds now that "value" was dropped from
//     the amount synonyms (grid.ts): while it was a synonym, gtbank's "Value
//     Date" header stole the amount mapping from Debit/Credit and every row was
//     silently dropped.
//   - zenith: detects and matches on debit rows, but loses every credit
//     amount — Zenith glues a trailing value date onto the CREDIT cell, and
//     the shared parseAmount (values.ts) rejects any cell that isn't a bare
//     number, unlike Zenith's own leading-token regex.
//   - uba / cowrywise: never detect the table at all — UBA's header is split
//     across three visual rows (no single row carries both a date and a
//     description label) and Cowrywise's breakdown table has no Date or
//     Description header at all (both live in an unlabelled margin).

import { describe, expect, test } from 'bun:test';
import type { Item } from '../src/parsers/pdf-shared.js';
import { genericParser } from '../src/parsers/pdf-generic.js';
import { gtbankParser } from '../src/parsers/pdf-gtbank.js';
import { zenithParser } from '../src/parsers/pdf-zenith.js';
import { ubaParser } from '../src/parsers/pdf-uba.js';
import { cowrywiseParser } from '../src/parsers/pdf-cowrywise.js';

function item(text: string, x: number, width: number, y: number): Item {
	return { text, x, y, width };
}

describe('generic vs gtbank', () => {
	// Short-form GTBank header on a single row: Trans Date | Reference |
	// Value Date | Debit | Credit | Balance | Remarks (pdf-gtbank.ts's comment
	// on `findColumns`). Only one of Debit/Credit is printed per row.
	const HEADER: Item[] = [
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
	function dataRow(r: Row, y: number): Item[] {
		const items: Item[] = [
			item(r.date, 50, 60, y),
			item(r.ref, 120, 70, y),
			item(r.balance, 400, 60, y),
			item(r.remarks, 470, 100, y)
		];
		if (r.debit !== undefined) items.push(item(r.debit, 280, 50, y));
		if (r.credit !== undefined) items.push(item(r.credit, 340, 50, y));
		return items;
	}
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
	const pages: Item[][] = [[...HEADER, ...ROWS.flatMap((r, i) => dataRow(r, 680 - i * 20))]];

	const tuned = gtbankParser.parse(pages);
	const generic = genericParser.parse(pages);

	test('tuned gtbank parser reads every row', () => {
		expect(tuned.rows.map((r) => r.amount)).toEqual([-5000, 10000, -1500]);
		expect(tuned.rows.map((r) => r.balance)).toEqual([95000, 105000, 103500]);
	});

	test('generic parser fully reproduces the tuned gtbank output', () => {
		expect(genericParser.detect(pages)).toBe(true);
		// "Remarks" maps to the description and Debit/Credit/Balance map directly,
		// so the generic parser matches the tuned parser row for row — now that
		// "value" is no longer an amount synonym colliding with "Value Date".
		expect(generic.rows.map((r) => r.amount)).toEqual(tuned.rows.map((r) => r.amount));
		expect(generic.rows.map((r) => r.balance)).toEqual(tuned.rows.map((r) => r.balance));
		expect(generic.rows.map((r) => r.description)).toEqual(tuned.rows.map((r) => r.description));
	});
});

describe('generic vs zenith', () => {
	// Clean fixed-column Zenith table (pdf-zenith.ts): DATE | DESCRIPTION |
	// DEBIT | CREDIT | BALANCE. Both money columns are always printed, the
	// unused one as "0.00", and a value date is glued onto the CREDIT cell as
	// one text run (e.g. "10,000.00 02/02/2026").
	const HEADER: Item[] = [
		item('Date', 50, 40, 700),
		item('Description', 100, 120, 700),
		item('Debit', 300, 60, 700),
		item('Credit', 380, 60, 700),
		item('Balance', 460, 70, 700)
	];
	function dataRow(
		date: string,
		desc: string,
		debit: string,
		credit: string,
		balance: string,
		y: number
	): Item[] {
		return [
			item(date, 50, 40, y),
			item(desc, 100, 120, y),
			item(debit, 300, 60, y),
			item(credit, 380, 60, y),
			item(balance, 460, 70, y)
		];
	}
	const pages: Item[][] = [
		[
			...HEADER,
			...dataRow('01/Feb/26', 'POS PURCHASE', '5,000.00', '0.00 01/02/2026', '95,000.00', 680),
			...dataRow('02/Feb/26', 'SALARY', '0.00', '10,000.00 02/02/2026', '105,000.00', 660)
		]
	];

	const tuned = zenithParser.parse(pages);
	const generic = genericParser.parse(pages);

	test('tuned zenith parser signs debit and credit rows correctly', () => {
		expect(tuned.rows.map((r) => r.amount)).toEqual([-5000, 10000]);
	});

	test('generic parser matches the debit row but loses the credit amount', () => {
		expect(genericParser.detect(pages)).toBe(true);
		expect(generic.rows).toHaveLength(2);
		// Debit row: the credit cell's glued value date doesn't affect it.
		expect(generic.rows[0].amount).toBe(tuned.rows[0].amount);
		// Credit row: parseAmount rejects "10,000.00 02/02/2026" outright (it
		// isn't a bare number), so the credit amount is lost entirely — the
		// generic parser reads it as a 0.00/0.00 row instead of a credit.
		expect(generic.rows[1].amount).toBe(0);
		expect(generic.rows[1].amount).not.toBe(tuned.rows[1].amount);
	});
});

describe('generic vs uba', () => {
	// UBA's header is split across three visual rows (pdf-uba.ts): TRANS |
	// VALUE | CHQ on top, NARRATION | DEBIT | CREDIT | BALANCE in the middle,
	// DATE | DATE | NO below. Only DEBIT or CREDIT is printed per row.
	const HEADER: Item[] = [
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
	function dataRow(
		transDate: string,
		narration: string,
		debit: string,
		credit: string,
		balance: string,
		y: number
	): Item[] {
		const items: Item[] = [
			item(transDate, 50, 30, y),
			item(narration, 170, 100, y),
			item(balance, 460, 60, y)
		];
		if (debit !== '') items.push(item(debit, 340, 50, y));
		if (credit !== '') items.push(item(credit, 400, 50, y));
		return items;
	}
	const pages: Item[][] = [
		[
			...HEADER,
			...dataRow('01-Feb-2026', 'POS PURCHASE', '5,000.00', '', '95,000.00', 680),
			...dataRow('02-Feb-2026', 'SALARY', '', '10,000.00', '105,000.00', 660)
		]
	];

	const tuned = ubaParser.parse(pages);

	test('tuned uba parser reads the split header and both rows', () => {
		expect(ubaParser.detect(pages)).toBe(true);
		expect(tuned.rows.map((r) => r.amount)).toEqual([-5000, 10000]);
	});

	test('generic parser never recognises the split header', () => {
		// No single visual row carries both a date-ish and a description-ish
		// label together (matchHeader/grid.ts requires both on one row), so
		// the table is invisible to the generic parser regardless of force.
		expect(genericParser.detect(pages)).toBe(false);
		const generic = genericParser.parse(pages);
		expect(generic.rows).toHaveLength(0);
		expect(generic.warnings[0]).toMatch(/header row/i);
	});
});

describe('generic vs cowrywise', () => {
	// Cowrywise's "Breakdown" table (pdf-cowrywise.ts) only headers Amount |
	// Fee | Type | Balance; the direction ("Inflow"/"Outflow") and date sit in
	// an unlabelled left margin across three stacked rows per transaction.
	const HEADER: Item[] = [
		item('Amount (₦)', 200, 60, 700),
		item('Fee (₦)', 280, 50, 700),
		item('Type', 350, 50, 700),
		item('Balance (₦)', 420, 70, 700)
	];
	function record(
		direction: string,
		amount: string,
		fee: string,
		type: string,
		balance: string,
		date: string,
		y: number
	): Item[] {
		return [
			item(direction, 50, 60, y),
			item(amount, 200, 60, y - 16),
			item(fee, 280, 50, y - 16),
			item(type, 350, 50, y - 16),
			item(balance, 420, 70, y - 16),
			item(date, 50, 80, y - 32)
		];
	}
	const pages: Item[][] = [
		[
			item('Cowrywise', 50, 80, 760),
			...HEADER,
			...record('Inflow', '5,100.00', '0.00', 'Deposit', '5,100.00', 'Feb 01, 2026', 670),
			...record('Outflow', '-1,000.00', '10.00', 'Withdrawal', '4,090.00', 'Feb 05, 2026', 610)
		]
	];

	const tuned = cowrywiseParser.parse(pages);

	test('tuned cowrywise parser reconstructs both three-row records', () => {
		expect(cowrywiseParser.detect(pages)).toBe(true);
		expect(tuned.rows.map((r) => r.amount)).toEqual([5100, -1000]);
	});

	test('generic parser never recognises the layout at all', () => {
		// There is no header cell that reads as a date or a description — both
		// live in the unlabelled left margin — so matchHeader can never match.
		expect(genericParser.detect(pages)).toBe(false);
		const generic = genericParser.parse(pages);
		expect(generic.rows).toHaveLength(0);
		expect(generic.warnings[0]).toMatch(/header row/i);
	});
});
