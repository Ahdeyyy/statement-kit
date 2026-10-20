// Zenith Bank statement parser.
//
// Zenith statements are a clean, upright, fixed-column table:
//
//   DATE | DESCRIPTION | DEBIT | CREDIT | VALUE DATE | BALANCE
//
// Two quirks shape the logic:
//   - Both DEBIT and CREDIT are always printed, the unused one as "0.00", so the
//     amount and its sign come straight from whichever column is non-zero rather
//     than from a balance delta (GTBank's approach).
//   - The VALUE DATE is glued onto the CREDIT cell as one text run, e.g.
//     "50,000.00 02/01/2026" or "0.00 07/01/2026", so the credit amount is the
//     cell's first token and the trailing date is ignored.
//
// Each transaction is one row carrying a date in the DATE column plus a balance;
// description text on rows below it (no date) wraps the preceding record. The
// header appears only on page 1; its column positions carry across pages.

import type { ParsedTransaction, ParseResult, StatementMeta } from './types.js';
import { parseStatementDate, parseAmount, cents } from './values.js';
import {
	clusterRows,
	normalizeCurrency,
	pageText,
	type Item,
	type PdfStatementParser,
	type VisualRow
} from './pdf-shared.js';

type Columns = {
	/** Right edge of the DATE column (start of DESCRIPTION). */
	dateRight: number;
	/** Right edge of DESCRIPTION (start of DEBIT). */
	descRight: number;
	/** Right edge of DEBIT (start of CREDIT). */
	debitRight: number;
	/** Right edge of CREDIT, i.e. start of the BALANCE column. */
	creditRight: number;
};

const NOISE_ROW =
	/page\s+\d+\s+of\s+\d+|alertz|www\.zenithbank|how to verify|cheque|subscription|^\s*totals\b|total\s*\(/i;

/**
 * Locate the header row and derive column boundaries from the label positions.
 * Boundaries sit just left of each label so right-aligned numeric values (which
 * extend rightward of their header) still classify correctly.
 */
function findColumns(rows: VisualRow[]): { columns: Columns; headerY: number } | null {
	for (const row of rows) {
		const cells = row.items;
		const find = (re: RegExp) => cells.find((c) => re.test(c.text.trim()));
		const date = find(/^date$/i);
		const description = find(/^description$/i);
		const debit = find(/^debit$/i);
		const credit = find(/^credit$/i);
		const balance = find(/^balance$/i);
		if (!date || !description || !debit || !credit || !balance) continue;
		return {
			headerY: row.y,
			columns: {
				dateRight: description.x - 6,
				descRight: debit.x - 6,
				debitRight: credit.x - 6,
				creditRight: balance.x - 6
			}
		};
	}
	return null;
}

function extractMeta(text: string): StatementMeta {
	const meta: StatementMeta = {};
	let m = /account\s*(?:number|no\.?)\s*:?\s*(\d{6,})/i.exec(text);
	if (m) meta.accountNumber = m[1];
	// Name is fully upper-case; require each word to be 2+ upper-case letters so
	// the title-cased "Account Statement" label printed beside it isn't absorbed.
	m = /ACCOUNT\s*NAME\s*:?\s*([A-Z][A-Z.'-]+(?:\s+[A-Z][A-Z.'-]+)*)/.exec(text);
	if (m) meta.accountName = m[1].trim();
	m = /currency\s*:?\s*([A-Za-z][A-Za-z ]{0,30})/i.exec(text);
	if (m) {
		const currency = normalizeCurrency(m[1]);
		if (currency !== undefined) meta.currency = currency;
	}
	m = /period\s*:?\s*(.+?)\s*(?:\n|$)/i.exec(text);
	if (m) meta.period = m[1].trim();
	// Opening balance is read from the table's "Opening Balance" row during the
	// parse pass (its value lives in the right-most BALANCE column, not next to
	// the label), so it isn't extracted from the text blob here.
	return meta;
}

/** Cells of one visual row bucketed into their columns. */
type RowCells = {
	date: string;
	description: string;
	debit: string;
	credit: string;
	balance: string;
};

function bucket(row: VisualRow, cols: Columns): RowCells {
	const parts: RowCells = { date: '', description: '', debit: '', credit: '', balance: '' };
	for (const item of row.items) {
		const text = item.text.trim();
		if (item.x < cols.dateRight) parts.date += (parts.date ? ' ' : '') + text;
		else if (item.x < cols.descRight) parts.description += (parts.description ? ' ' : '') + text;
		else if (item.x < cols.debitRight) parts.debit += (parts.debit ? ' ' : '') + text;
		else if (item.x < cols.creditRight) parts.credit += (parts.credit ? ' ' : '') + text;
		else parts.balance += (parts.balance ? ' ' : '') + text;
	}
	return parts;
}

function parseZenith(pages: Item[][]): ParseResult<'zenith'> {
	const warnings: string[] = [];
	let meta: StatementMeta = {};
	let columns: Columns | null = null;

	type Anchor = {
		date: number;
		amount: number;
		balance: number;
		descriptionParts: string[];
	};
	const anchors: Anchor[] = [];
	let current: Anchor | null = null;
	let previousBalance: number | null = null;

	for (let pageNum = 1; pageNum <= pages.length; pageNum++) {
		const rows = clusterRows(pages[pageNum - 1]);

		if (pageNum === 1) {
			meta = extractMeta(pageText(rows));
			previousBalance = meta.openingBalance ?? null;
		}

		const found = findColumns(rows);
		let headerY = Infinity;
		if (found !== null) {
			columns = found.columns;
			headerY = found.headerY;
		}
		if (columns === null) continue;
		const cols = columns;

		// clusterRows already returns top-of-page first (y descending), i.e.
		// reading order, so anchors and their wrapped description lines arrive in
		// sequence.
		for (const row of rows) {
			if (row.y >= headerY) continue; // header and anything above it
			const line = row.items.map((i) => i.text).join(' ');

			const parts = bucket(row, cols);
			const date = parseStatementDate(parts.date);
			const balance = parseAmount(parts.balance);

			// "Opening Balance" row: no date, value in the BALANCE column. Seeds the
			// running balance used to reconcile and to sign any all-zero rows.
			if (date === null && /opening\s*balance/i.test(parts.description) && balance !== null) {
				if (meta.openingBalance === undefined) meta.openingBalance = balance;
				previousBalance = balance;
				continue;
			}
			// Footers, totals and the trailing info banners separate records: drop
			// the row and stop attaching continuations to the record above, so the
			// page-end prose can't append to the last transaction's description.
			// (Zenith never wraps a description across a page break.)
			if (NOISE_ROW.test(line)) {
				current = null;
				continue;
			}

			if (date !== null && balance !== null) {
				// A new transaction: amount comes from the non-zero debit/credit
				// column. The credit cell carries a trailing value date, so take its
				// leading number.
				const debit = parseAmount(parts.debit) ?? 0;
				const creditToken = /^([\d,]+\.?\d*)/.exec(parts.credit.trim())?.[1] ?? '';
				const credit = parseAmount(creditToken) ?? 0;
				let amount: number;
				if (credit !== 0) amount = credit;
				else if (debit !== 0) amount = -debit;
				else if (previousBalance !== null) {
					// Both columns zero (rare): fall back to the balance delta.
					amount = balance - previousBalance;
				} else amount = 0;

				current = {
					date,
					amount,
					balance,
					descriptionParts: parts.description ? [parts.description] : []
				};
				anchors.push(current);
				previousBalance = balance;
			} else if (current !== null && parts.description !== '') {
				// A description that wrapped onto its own line, no date/balance.
				current.descriptionParts.push(parts.description);
			}
		}
	}

	if (columns === null) {
		return {
			rows: [],
			meta,
			warnings: ['Could not find a Zenith DATE/DESCRIPTION/DEBIT/CREDIT/BALANCE table.']
		};
	}

	const transactions: ParsedTransaction<'zenith'>[] = anchors.map((a) => ({
		date: a.date,
		description: a.descriptionParts.join(' ').replace(/\s+/g, ' ').trim(),
		amount: a.amount,
		balance: a.balance
	}));

	// Sanity check the running balance so a column misread surfaces as a warning
	// rather than silently wrong numbers. Reconcile over `anchors` (balance is a
	// required number there, unlike the optional field on a transaction).
	let prev = meta.openingBalance ?? null;
	let mismatches = 0;
	for (const a of anchors) {
		if (prev !== null && cents(prev + a.amount) !== cents(a.balance)) mismatches++;
		prev = a.balance;
	}
	if (mismatches > 0) {
		warnings.push(`${mismatches} of ${anchors.length} rows did not reconcile with the balance.`);
	}

	return { rows: transactions, meta, warnings };
}

export const zenithParser: PdfStatementParser<'zenith'> = {
	name: 'zenith',
	detect: (pages) => {
		const first = clusterRows(pages[0] ?? []);
		if (/zenith bank/i.test(pageText(first))) return true;
		// Fall back to the distinctive header shape in case branding changes.
		return findColumns(first) !== null;
	},
	parse: parseZenith
};
