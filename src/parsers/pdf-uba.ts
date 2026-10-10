// UBA (United Bank for Africa) statement parser.
//
// UBA statements are an upright, fixed-column table:
//
//   TRANS DATE | VALUE DATE | NARRATION | CHQ NO | DEBIT | CREDIT | BALANCE
//
// Two quirks shape the logic:
//   - Only the relevant money column is printed per row (an unused DEBIT/CREDIT
//     is simply absent, not "0.00"), so the amount and its sign come from
//     whichever of DEBIT/CREDIT is present rather than from a balance delta.
//   - The NARRATION wraps across several stacked rows and the row that actually
//     carries the dates+amount+balance (the "anchor") sits *in the middle* of
//     that block — narration lines appear both above and below it. So narration
//     fragments are gathered separately and each is attached to the nearest
//     anchor by vertical distance, then joined top-to-bottom.
//
// The header is split across three visual rows (TRANS/VALUE/CHQ on top,
// NARRATION/DEBIT/CREDIT/BALANCE in the middle, DATE/DATE/NO below); the middle
// row anchors column detection and the TRANS/VALUE labels above supply the two
// date columns' x-positions. Page 1 is a summary (no table); the header repeats
// on every page that carries transactions.

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
	/** Right edge of TRANS DATE (start of VALUE DATE). */
	transDateRight: number;
	/** Right edge of VALUE DATE (start of NARRATION). */
	valueDateRight: number;
	/** Right edge of NARRATION/CHQ (start of DEBIT). */
	narrationRight: number;
	/** Right edge of DEBIT (start of CREDIT). */
	debitRight: number;
	/** Right edge of CREDIT (start of BALANCE). */
	creditRight: number;
};

// Footer slogan/page marker and the split sub-header labels separate the table
// from page furniture; matching rows are dropped so trailing prose can't leak
// into a transaction's narration.
const NOISE_ROW = /africa'?s global bank|bank statement\s*-\s*\d+|^\s*date\s+date\s+no\s*$/i;

/**
 * Locate the header and derive column boundaries. The middle header row carries
 * NARRATION/DEBIT/CREDIT/BALANCE; the TRANS and VALUE date labels sit a few
 * points above it (their own visual row), so they're picked up from items within
 * a small y-window of the header. Numeric columns are right-aligned, so their
 * boundaries are midpoints between adjacent label centres; the narration's right
 * edge is set just left of the DEBIT label (folding the seldom-used CHQ NO column
 * into narration, which is harmless since narration is a single left-aligned run).
 */
function findColumns(rows: VisualRow[]): { columns: Columns; headerY: number } | null {
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const find = (cells: Item[], re: RegExp) => cells.find((c) => re.test(c.text.trim()));
		const narration = find(row.items, /^narration$/i);
		const debit = find(row.items, /^debit$/i);
		const credit = find(row.items, /^credit$/i);
		const balance = find(row.items, /^balance$/i);
		if (!narration || !debit || !credit || !balance) continue;

		// TRANS and VALUE labels live on the neighbouring header rows; gather every
		// item within a small y-window to find them regardless of row clustering.
		const near = rows
			.filter((r) => Math.abs(r.y - row.y) <= 10)
			.flatMap((r) => r.items);
		const trans = find(near, /^trans$/i);
		const value = find(near, /^value$/i);
		if (!trans || !value) continue;

		return {
			headerY: row.y,
			columns: {
				transDateRight: (trans.x + value.x) / 2,
				valueDateRight: (value.x + narration.x) / 2,
				narrationRight: debit.x - 20,
				debitRight: (debit.x + credit.x) / 2,
				creditRight: (credit.x + balance.x) / 2
			}
		};
	}
	return null;
}

function extractMeta(text: string): StatementMeta {
	const meta: StatementMeta = {};
	// The greeting line carries the full account name: "Hello <NAME>!".
	let m = /hello\s+(.+?)\s*!/i.exec(text);
	if (m) meta.accountName = m[1].trim();
	// Account number is masked, e.g. "214xxxxx25".
	m = /\b(\d{2,}[xX]{2,}\d{2,})\b/.exec(text);
	if (m) meta.accountNumber = m[1];
	m = /currency\s*:?\s*([A-Za-z][A-Za-z ]{0,30})/i.exec(text);
	if (m) {
		const currency = normalizeCurrency(m[1]);
		if (currency !== undefined) meta.currency = currency;
	}
	m = /opening\s*balance\s*:?\s*([\d,]+\.\d{2})/i.exec(text);
	if (m) {
		const opening = parseAmount(m[1]);
		if (opening !== null) meta.openingBalance = opening;
	}
	// Period prints as "(01-Feb-2026 - 28-Feb-2026)".
	m = /\((\d{1,2}-[A-Za-z]{3,}-\d{2,4}\s*-\s*\d{1,2}-[A-Za-z]{3,}-\d{2,4})\)/.exec(text);
	if (m) meta.period = m[1].trim();
	return meta;
}

/** Cells of one visual row bucketed into their columns. */
type RowCells = {
	transDate: string;
	valueDate: string;
	narration: string;
	debit: string;
	credit: string;
	balance: string;
};

function bucket(row: VisualRow, cols: Columns): RowCells {
	const parts: RowCells = {
		transDate: '',
		valueDate: '',
		narration: '',
		debit: '',
		credit: '',
		balance: ''
	};
	const add = (key: keyof RowCells, text: string) => {
		parts[key] += (parts[key] ? ' ' : '') + text;
	};
	for (const item of row.items) {
		const text = item.text.trim();
		if (item.x < cols.transDateRight) add('transDate', text);
		else if (item.x < cols.valueDateRight) add('valueDate', text);
		else if (item.x < cols.narrationRight) add('narration', text);
		else if (item.x < cols.debitRight) add('debit', text);
		else if (item.x < cols.creditRight) add('credit', text);
		else add('balance', text);
	}
	return parts;
}

type Anchor = {
	date: number;
	amount: number;
	balance: number;
	y: number;
	/** Narration fragments {y, text}, joined top-to-bottom at the end. */
	fragments: { y: number; text: string }[];
};

function parseUba(pages: Item[][]): ParseResult {
	const warnings: string[] = [];
	let meta: StatementMeta = {};
	let columns: Columns | null = null;
	let openingBalance: number | undefined;

	const anchors: Anchor[] = [];

	for (let pageNum = 1; pageNum <= pages.length; pageNum++) {
		const rows = clusterRows(pages[pageNum - 1]);

		if (pageNum === 1) {
			meta = extractMeta(pageText(rows));
			openingBalance = meta.openingBalance;
		}

		const found = findColumns(rows);
		let headerY = Infinity;
		if (found !== null) {
			columns = found.columns;
			headerY = found.headerY;
		}
		if (columns === null) continue;
		const cols = columns;

		// First pass: collect this page's anchors and its loose narration
		// fragments. clusterRows returns top-of-page first (reading order).
		const pageAnchors: Anchor[] = [];
		const fragments: { y: number; text: string }[] = [];

		for (const row of rows) {
			// Skip the header and the split sub-header rows just below it.
			if (row.y >= headerY - 10) continue;
			const line = row.items.map((i) => i.text).join(' ');
			if (NOISE_ROW.test(line)) continue;

			const parts = bucket(row, cols);
			const date = parseStatementDate(parts.transDate);
			const balance = parseAmount(parts.balance);

			// The opening-balance row seeds the running balance; it isn't a txn.
			if (/opening\s*balance/i.test(parts.narration)) {
				if (balance !== null) {
					if (openingBalance === undefined) openingBalance = balance;
				}
				continue;
			}

			if (date !== null && balance !== null) {
				const debit = parseAmount(parts.debit);
				const credit = parseAmount(parts.credit);
				let amount: number;
				if (credit !== null && credit !== 0) amount = credit;
				else if (debit !== null && debit !== 0) amount = -debit;
				else amount = 0;

				const anchor: Anchor = { date, amount, balance, y: row.y, fragments: [] };
				pageAnchors.push(anchor);
				if (parts.narration) fragments.push({ y: row.y, text: parts.narration });
			} else if (parts.narration) {
				fragments.push({ y: row.y, text: parts.narration });
			}
		}

		// Attach each fragment to the nearest anchor on this page (a transaction's
		// narration wraps both above and below its anchor row).
		for (const frag of fragments) {
			let best: Anchor | null = null;
			let bestDist = Infinity;
			for (const a of pageAnchors) {
				const dist = Math.abs(a.y - frag.y);
				if (dist < bestDist) {
					bestDist = dist;
					best = a;
				}
			}
			if (best !== null) best.fragments.push(frag);
		}

		anchors.push(...pageAnchors);
	}

	if (columns === null) {
		return {
			rows: [],
			meta,
			warnings: ['Could not find a UBA TRANS DATE/NARRATION/DEBIT/CREDIT/BALANCE table.']
		};
	}

	if (meta.openingBalance === undefined && openingBalance !== undefined) {
		meta.openingBalance = openingBalance;
	}

	const transactions: ParsedTransaction[] = anchors.map((a) => ({
		date: a.date,
		description: a.fragments
			.sort((x, y) => y.y - x.y) // top-of-block first
			.map((f) => f.text)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim(),
		amount: a.amount,
		balance: a.balance
	}));

	// Sanity-check the running balance so a column misread surfaces as a warning
	// rather than silently wrong numbers.
	let prev = openingBalance ?? null;
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

export const ubaParser: PdfStatementParser = {
	name: 'uba',
	detect: (pages) => {
		const first = clusterRows(pages[0] ?? []);
		if (/africa'?s global bank|united bank for africa/i.test(pageText(first))) return true;
		// Fall back to the distinctive header shape on any of the first few pages,
		// in case the slogan changes (page 1 is a summary, so the table — and its
		// header — appears from page 2 onward).
		for (const page of pages.slice(0, 3)) {
			if (findColumns(clusterRows(page)) !== null) return true;
		}
		return false;
	},
	parse: parseUba
};
