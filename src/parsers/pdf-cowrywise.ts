// Cowrywise statement parser (Naira Stash and the other ₦/$ "Stash"-style
// savings plans, whose breakdown shares this layout).
//
// Cowrywise prints each transaction as three stacked rows in a fixed-column
// "Breakdown" table:
//
//                              Amount (₦) | Fee (₦) | Type | Balance (₦)
//   Inflow                                                              <- direction
//                               5,100.00  |   0.00  | ...  |  5,100.00   <- values
//   Feb 01, 2026                                                        <- date
//
// The direction label and the date sit in the left margin (their own rows); the
// money columns sit on the middle row. The Amount column is already signed
// (negative for outflows), and the running Balance reconciles as
//   newBalance = oldBalance + amount - (outflow ? fee : 0)
// i.e. the fee reduces the balance only on outflows. There is no opening-balance
// row; the table opens straight into the first transaction.
//
// Cowrywise offers several products (Stash, mutual funds, Life Goals, …) that
// can each ship a differently-shaped statement, so detection requires both the
// Cowrywise branding and this Amount/Fee/Type/Balance header — an unrecognised
// Cowrywise layout falls through to the generic parser rather than being parsed
// wrongly here.

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
	/** Right edge of the left margin (direction/date), i.e. start of AMOUNT. */
	amountLeft: number;
	/** Right edge of AMOUNT (start of FEE). */
	feeLeft: number;
	/** Right edge of FEE (start of TYPE). */
	typeLeft: number;
	/** Right edge of TYPE (start of BALANCE). */
	balanceLeft: number;
	/** Currency parsed from the "(₦)"/"($)" header label, if recognised. */
	currency?: string;
};

const NOISE_ROW =
	/cowrywise financial|portfolio manager|page\s+\d+\s+of\s+\d+|securities and exchange|email:|rc number/i;

/**
 * Locate the header row and derive column boundaries from the label positions.
 * Values are left-aligned under their labels, so a boundary just left of each
 * label (label.x - 6) classifies the cells correctly.
 */
function findColumns(rows: VisualRow[]): { columns: Columns; headerY: number } | null {
	for (const row of rows) {
		const cells = row.items;
		const find = (re: RegExp) => cells.find((c) => re.test(c.text.trim()));
		const amount = find(/^amount\b/i);
		const fee = find(/^fee\b/i);
		const type = find(/^type\b/i);
		const balance = find(/^balance\b/i);
		if (!amount || !fee || !type || !balance) continue;
		return {
			headerY: row.y,
			columns: {
				amountLeft: amount.x - 6,
				feeLeft: fee.x - 6,
				typeLeft: type.x - 6,
				balanceLeft: balance.x - 6,
				currency: normalizeCurrency(`${amount.text} ${balance.text}`)
			}
		};
	}
	return null;
}

function extractMeta(text: string, currency?: string): StatementMeta {
	const meta: StatementMeta = {};
	if (currency !== undefined) meta.currency = currency;
	// "Account Holder" labels the row above the name.
	let m = /account\s*holder\s*\n+\s*([^\n]+)/i.exec(text);
	if (m) meta.accountName = m[1].trim();
	// The date range sits on the line under "<Plan> Breakdown".
	m = /breakdown\s*\n+\s*([^\n]+)/i.exec(text);
	if (m) meta.period = m[1].trim();
	return meta;
}

/** Cells of one visual row bucketed into their columns. */
type RowCells = { left: string; amount: string; fee: string; type: string; balance: string };

function bucket(row: VisualRow, cols: Columns): RowCells {
	const parts: RowCells = { left: '', amount: '', fee: '', type: '', balance: '' };
	const add = (key: keyof RowCells, text: string) => {
		parts[key] += (parts[key] ? ' ' : '') + text;
	};
	for (const item of row.items) {
		const text = item.text.trim();
		if (item.x < cols.amountLeft) add('left', text);
		else if (item.x < cols.feeLeft) add('amount', text);
		else if (item.x < cols.typeLeft) add('fee', text);
		else if (item.x < cols.balanceLeft) add('type', text);
		else add('balance', text);
	}
	return parts;
}

type Anchor = {
	date: number | null;
	amount: number;
	fee: number;
	balance: number;
	type: string;
	direction: 'inflow' | 'outflow' | null;
};

function parseCowrywise(pages: Item[][]): ParseResult {
	const warnings: string[] = [];
	let meta: StatementMeta = {};
	let columns: Columns | null = null;
	const anchors: Anchor[] = [];

	// Direction precedes its value row; the date follows it. Carry the pending
	// direction onto the next value row, and attach a trailing date to the last
	// anchor created.
	let pendingDirection: Anchor['direction'] = null;
	let lastAnchor: Anchor | null = null;

	for (let pageNum = 1; pageNum <= pages.length; pageNum++) {
		const rows = clusterRows(pages[pageNum - 1]);

		const found = findColumns(rows);
		let headerY = Infinity;
		if (found !== null) {
			columns = found.columns;
			headerY = found.headerY;
		}
		if (pageNum === 1) meta = extractMeta(pageText(rows), columns?.currency);
		if (columns === null) continue;
		const cols = columns;

		// clusterRows returns top-of-page first (reading order), so direction,
		// value and date rows arrive in sequence.
		for (const row of rows) {
			if (row.y >= headerY) continue; // header and the summary above it
			const line = row.items.map((i) => i.text).join(' ');
			if (NOISE_ROW.test(line)) {
				pendingDirection = null;
				continue;
			}

			const parts = bucket(row, cols);
			const amount = parseAmount(parts.amount);
			const balance = parseAmount(parts.balance);
			const leftText = parts.left.trim();

			if (amount !== null && balance !== null) {
				// The value row: sign the amount by the direction label (falling back
				// to the printed sign), and record the fee for reconciliation.
				const fee = parseAmount(parts.fee) ?? 0;
				const direction = pendingDirection;
				const signed =
					direction === 'outflow'
						? -Math.abs(amount)
						: direction === 'inflow'
							? Math.abs(amount)
							: amount;
				lastAnchor = {
					date: null,
					amount: signed,
					fee,
					balance,
					type: parts.type.trim(),
					direction
				};
				anchors.push(lastAnchor);
				pendingDirection = null;
			} else if (/^(inflow|outflow)$/i.test(leftText)) {
				pendingDirection = leftText.toLowerCase() as Anchor['direction'];
			} else if (lastAnchor !== null && lastAnchor.date === null) {
				const date = parseStatementDate(leftText);
				if (date !== null) lastAnchor.date = date;
			}
		}
	}

	if (columns === null) {
		return {
			rows: [],
			meta,
			warnings: ['Could not find a Cowrywise Amount/Fee/Type/Balance breakdown table.']
		};
	}

	const transactions: ParsedTransaction[] = [];
	for (const a of anchors) {
		if (a.date === null) {
			warnings.push(`Skipped a ${a.type || 'transaction'} row with no date.`);
			continue;
		}
		const description = a.fee > 0 ? `${a.type} (fee ${a.fee.toFixed(2)})` : a.type;
		transactions.push({
			date: a.date,
			description,
			amount: a.amount,
			balance: a.balance
		});
	}

	// Reconcile the running balance (fees reduce it only on outflows) so a column
	// misread surfaces as a warning instead of silently wrong numbers.
	let prev: number | null = null;
	let mismatches = 0;
	for (const a of anchors) {
		if (a.date === null) continue;
		const delta = a.amount - (a.amount < 0 ? a.fee : 0);
		if (prev !== null && cents(prev + delta) !== cents(a.balance)) mismatches++;
		prev = a.balance;
	}
	if (mismatches > 0) {
		warnings.push(
			`${mismatches} of ${transactions.length} rows did not reconcile with the balance.`
		);
	}

	return { rows: transactions, meta, warnings };
}

export const cowrywiseParser: PdfStatementParser = {
	name: 'cowrywise',
	// Require both the Cowrywise branding and this breakdown header so other
	// Cowrywise products' statements aren't misrouted here.
	detect: (pages) => {
		const rows = clusterRows(pages[0] ?? []);
		if (!/cowrywise/i.test(pageText(rows))) return false;
		return findColumns(rows) !== null;
	},
	parse: parseCowrywise
};
