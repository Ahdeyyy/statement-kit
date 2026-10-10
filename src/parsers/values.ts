// Date and amount parsing shared by all statement parsers.

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11
};

function utc(year: number, month: number, day: number): number | null {
	if (month < 0 || month > 11 || day < 1 || day > 31) return null;
	const fullYear = year < 100 ? 2000 + year : year;
	const ms = Date.UTC(fullYear, month, day);
	const d = new Date(ms);
	if (d.getUTCDate() !== day || d.getUTCMonth() !== month) return null;
	return ms;
}

/** Month index (0-11) from a full or abbreviated name, or undefined. */
function monthIndex(name: string): number | undefined {
	return MONTHS[name.slice(0, 3).toLowerCase()];
}

/**
 * Parse the date formats seen on bank statements. Handles named-month and
 * all-numeric layouts in day-first, month-first and year-first order:
 * "01/FEB/26", "01-Jun-2026", "01Mar 2026", "March 1, 2026", "Jun-01-2026",
 * "2026-03-01", "2026/03/01", "2026 Jun 01", "01/03/2026" (day-first).
 *
 * Tolerant of surrounding noise: a leading weekday ("Wed, "), ordinal day
 * suffixes ("1st"), non-breaking spaces, and any trailing content after the
 * date (a time like "14:30:00" or a repeated value date in the same cell) are
 * all ignored, since callers pass a cell already identified as the date column.
 */
export function parseStatementDate(raw: string): number | null {
	let text = raw.replace(/ /g, ' ').trim();
	if (text.length === 0) return null;
	// Drop a leading weekday ("Wed," / "Wednesday ").
	text = text.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '');
	// Strip ordinal suffixes on day numbers ("1st" -> "1", "23rd" -> "23").
	text = text.replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
	if (text.length === 0) return null;

	// Patterns are anchored at the start only, so a trailing time, a second
	// (value) date, or other trailing noise is ignored. Each pattern validates
	// its match (via utc / a real month name) and falls through on failure.

	// Year-first numeric: 2026-03-01, 2026/03/01, 2026.03.01 (also ISO datetimes).
	let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
	if (m) {
		const d = utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
		if (d !== null) return d;
	}

	// Year-first with a named month: 2026 Jun 01.
	m = /^(\d{4})[-/. ]+([A-Za-z]{3,9})[-/. ]+(\d{1,2})\b/.exec(text);
	if (m) {
		const month = monthIndex(m[2]);
		if (month !== undefined) {
			const d = utc(Number(m[1]), month, Number(m[3]));
			if (d !== null) return d;
		}
	}

	// Day-first with a named month: 01-Jun-2026, 01/FEB/26, 01Jun2026, 01 June 2026.
	m = /^(\d{1,2})[-/. ]*([A-Za-z]{3,9})[-/. ,]*(\d{2,4})\b/.exec(text);
	if (m) {
		const month = monthIndex(m[2]);
		if (month !== undefined) {
			const d = utc(Number(m[3]), month, Number(m[1]));
			if (d !== null) return d;
		}
	}

	// Month-first with a named month: Jun-01-2026, June 1, 2026, JUN 1 2026.
	m = /^([A-Za-z]{3,9})[-/. ,]+(\d{1,2})[-/. ,]+(\d{2,4})\b/.exec(text);
	if (m) {
		const month = monthIndex(m[1]);
		if (month !== undefined) {
			const d = utc(Number(m[3]), month, Number(m[2]));
			if (d !== null) return d;
		}
	}

	// All-numeric: 01/03/2026, 01-03-26, 01.03.2026. Day-first by the Nigerian
	// bank convention; fall back to month-first when day-first is out of range.
	m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(text);
	if (m) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		const year = Number(m[3]);
		return utc(year, b - 1, a) ?? utc(year, a - 1, b);
	}

	return null;
}

/**
 * Parse statement amounts: "1,099.22", ".75", "(500.00)" as negative,
 * optional currency symbols. Returns null for non-numbers.
 */
export function parseAmount(raw: string): number | null {
	let text = raw.replace(/\u00a0/g, ' ').trim();
	if (text.length === 0 || text === '-') return null;
	let negative = false;
	if (/^\(.*\)$/.test(text)) {
		negative = true;
		text = text.slice(1, -1);
	}
	if (text.startsWith('-')) {
		negative = true;
		text = text.slice(1);
	}
	text = text.replace(/[₦$€£]|NGN|USD|CR|DR/gi, '').replace(/[,\s]/g, '');
	if (!/^(\d+(\.\d+)?|\.\d+)$/.test(text)) return null;
	const value = Number(text);
	return negative ? -value : value;
}

/** Round to 2dp to avoid float drift when comparing money. */
export function cents(value: number): number {
	return Math.round(value * 100);
}
