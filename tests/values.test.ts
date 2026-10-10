// Date/amount parsing shared by all statement parsers. These cases pin down the
// range of plausible date layouts seen across bank statements — named-month and
// all-numeric, in day-first / month-first / year-first order, plus tolerated
// noise (leading weekday, ordinal suffixes, trailing time or a repeated value
// date in the same cell).

import { describe, expect, test } from 'bun:test';
import { parseStatementDate, parseAmount } from '../src/parsers/values.js';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

describe('parseStatementDate', () => {
	const jun1 = '2026-06-01';
	const cases: [string, string | null][] = [
		// Named month, day-first
		['01-Jun-2026', jun1],
		['01/Jun/2026', jun1],
		['01 Jun 2026', jun1],
		['01Jun2026', jun1],
		['1-Jun-26', jun1],
		['01-June-2026', jun1],
		['01/FEB/26', '2026-02-01'],
		// Named month, month-first
		['Jun-01-2026', jun1],
		['Jun 01, 2026', jun1],
		['Jun 1 2026', jun1],
		['JUN-1-2026', jun1],
		['March 1, 2026', '2026-03-01'],
		// Year-first
		['2026-06-01', jun1],
		['2026/06/01', jun1],
		['2026.06.01', jun1],
		['2026 Jun 01', jun1],
		// All-numeric, day-first convention
		['01/06/2026', jun1],
		['01.06.2026', jun1],
		['13/06/2026', '2026-06-13'],
		['06/01/2026', '2026-01-06'],
		// Month-first fallback when day-first is out of range
		['06-13-2026', '2026-06-13'],
		// Tolerated noise: weekday, ordinals, trailing time, repeated value date
		['Wed, 01 Jun 2026', jun1],
		['Wednesday 01 Jun 2026', jun1],
		['1st Jun 2026', jun1],
		['Jun 1st, 2026', jun1],
		['01-Jun-2026 14:30:00', jun1],
		['2026-06-01T14:30:00', jun1],
		['01-Jun-2026 01-Jun-2026', jun1],
		['  01-Jun-2026  ', jun1],
		// Rejected
		['31-Feb-2026', null],
		['2026-13-01', null],
		['', null],
		['-', null],
		['Balance b/f', null],
		['hello world', null]
	];

	for (const [input, expected] of cases) {
		test(`${JSON.stringify(input)} -> ${expected}`, () => {
			expect(iso(parseStatementDate(input))).toBe(expected);
		});
	}
});

describe('parseAmount', () => {
	test('parses common formats', () => {
		expect(parseAmount('1,099.22')).toBe(1099.22);
		expect(parseAmount('.75')).toBe(0.75);
		expect(parseAmount('(500.00)')).toBe(-500);
		expect(parseAmount('-250')).toBe(-250);
		expect(parseAmount('₦1,000')).toBe(1000);
	});

	test('rejects non-numbers', () => {
		expect(parseAmount('')).toBeNull();
		expect(parseAmount('-')).toBeNull();
		expect(parseAmount('abc')).toBeNull();
	});
});
