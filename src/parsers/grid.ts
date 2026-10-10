// Turn a grid (array of string rows, e.g. from CSV or a spreadsheet) into
// transactions by locating a header row and mapping its columns.

import type { ParsedTransaction, ParseResult } from './types.js';
import { parseStatementDate, parseAmount } from './values.js';

type ColumnMap = {
	date: number;
	description: number;
	debit?: number;
	credit?: number;
	amount?: number;
	balance?: number;
	reference?: number;
};

const HEADER_SYNONYMS: Record<keyof ColumnMap, string[]> = {
	date: ['trans date', 'transaction date', 'date', 'value date', 'posting date', 'post date'],
	description: [
		'description',
		'remarks',
		'narration',
		'details',
		'particulars',
		'transaction details',
		'transaction description',
		'memo',
		'note',
		'narrative'
	],
	debit: [
		'debit',
		'withdrawal',
		'withdrawals',
		'money out',
		'expense',
		'expenses',
		'spending',
		'outflow',
		'out flow',
		'amount out'
	],
	credit: [
		'credit',
		'deposit',
		'deposits',
		'money in',
		'income',
		'inflow',
		'in flow',
		'amount in',
		'lodgement',
		'lodgment'
	],
	amount: ['amount', 'transaction amount'],
	balance: ['balance', 'running balance', 'closing balance', 'available balance', 'ledger balance'],
	reference: ['reference', 'ref no', 'ref']
};

/**
 * Map a row of header cells to canonical column indices, or null when the row
 * isn't a recognisable header (needs at least a date, a description and one of
 * amount/debit/credit). Exported so the PDF table extractor reuses the exact
 * same header recognition that CSV/XLS use.
 */
export function matchHeader(cells: string[]): ColumnMap | null {
	const normalized = cells.map((c) => c.trim().toLowerCase());
	const found: Partial<Record<keyof ColumnMap, number>> = {};
	for (const [field, names] of Object.entries(HEADER_SYNONYMS) as [keyof ColumnMap, string[]][]) {
		for (const name of names) {
			const index = normalized.findIndex(
				(cell, i) =>
					(cell === name || (cell.includes(name) && cell.length <= name.length + 6)) &&
					!Object.values(found).includes(i)
			);
			if (index !== -1) {
				found[field] = index;
				break;
			}
		}
	}
	if (found.date === undefined || found.description === undefined) return null;
	const hasAmounts =
		found.amount !== undefined || found.debit !== undefined || found.credit !== undefined;
	if (!hasAmounts) return null;
	return found as ColumnMap;
}

export function extractFromGrid(grid: string[][]): ParseResult {
	const warnings: string[] = [];

	let columns: ColumnMap | null = null;
	let headerRow = -1;
	for (let i = 0; i < grid.length; i++) {
		columns = matchHeader(grid[i]);
		if (columns !== null) {
			headerRow = i;
			break;
		}
	}
	if (columns === null) {
		return {
			rows: [],
			meta: {},
			warnings: ['Could not find a header row with date, description and amount columns.']
		};
	}

	const rows: ParsedTransaction[] = [];
	for (let i = headerRow + 1; i < grid.length; i++) {
		const cells = grid[i];
		const cell = (index: number | undefined) =>
			index === undefined ? '' : String(cells[index] ?? '').trim();

		if (cells.every((c) => String(c ?? '').trim() === '')) continue;

		const date = parseStatementDate(cell(columns.date));
		if (date === null) {
			const nonEmpty = cells.filter((c) => String(c ?? '').trim() !== '');
			if (nonEmpty.length >= 2) {
				warnings.push(`Skipped row ${i + 1}: unrecognized date "${cell(columns.date)}".`);
			}
			continue;
		}

		let amount: number | null = null;
		if (columns.amount !== undefined) {
			amount = parseAmount(cell(columns.amount));
		} else {
			const debit = columns.debit === undefined ? null : parseAmount(cell(columns.debit));
			const credit = columns.credit === undefined ? null : parseAmount(cell(columns.credit));
			if (debit !== null && debit !== 0) amount = -Math.abs(debit);
			else if (credit !== null) amount = Math.abs(credit);
			else if (debit !== null) amount = 0;
		}
		if (amount === null) {
			warnings.push(`Skipped row ${i + 1}: no parsable amount.`);
			continue;
		}

		const balance = columns.balance === undefined ? null : parseAmount(cell(columns.balance));
		const reference = cell(columns.reference).replace(/^'/, '');

		rows.push({
			date,
			description: cell(columns.description).replace(/\s+/g, ' ').trim(),
			amount,
			balance: balance ?? undefined,
			reference: reference === '' ? undefined : reference
		});
	}

	return { rows, meta: {}, warnings };
}
