// Layout-agnostic statement parser, the dispatcher's final fallback. It makes no
// assumptions about a specific bank: it extracts a table from the positioned PDF
// text (see `pdf-table.ts`) and maps the header to canonical fields with the same
// synonym matching CSV/XLS use (`grid.ts`), so it recognises common layouts the
// tuned parsers don't — single signed Amount columns, Money In/Out, Expense/
// Income, Withdrawal/Deposit, Narration/Particulars, and so on. Best-effort by
// design; the tuned parsers stay authoritative for their banks.

import type { ParseResult, StatementMeta } from './types.js';
import { parseAmount } from './values.js';
import { clusterRows, normalizeCurrency, pageText, type Item, type PdfStatementParser } from './pdf-shared.js';
import { extractFromGrid } from './grid.js';
import { extractTable, findHeaderColumns } from './pdf-table.js';

/** Cheap best-effort metadata from the first page's text blob. */
export function extractMeta(text: string): StatementMeta {
	const meta: StatementMeta = {};
	let m = /account\s*(?:no\.?|number)?\s*:?\s*(\d{6,})/i.exec(text);
	if (m) meta.accountNumber = m[1];
	m = /currency\s*:?\s*([A-Za-z][A-Za-z ]{0,30})/i.exec(text);
	if (m) {
		const currency = normalizeCurrency(m[1]);
		if (currency !== undefined) meta.currency = currency;
	}
	m = /opening\s*balance\s*:?\s*([\d,]+\.?\d*)/i.exec(text);
	if (m) meta.openingBalance = parseAmount(m[1]) ?? undefined;
	return meta;
}

function parseGeneric(pages: Item[][]): ParseResult<'generic'> {
	const { grid } = extractTable(pages);
	const result = extractFromGrid(grid);
	const meta = pages.length > 0 ? extractMeta(pageText(clusterRows(pages[0]))) : {};
	return { ...result, meta: { ...meta, ...result.meta } };
}

export const genericParser: PdfStatementParser<'generic'> = {
	name: 'generic',
	detect: (pages) => findHeaderColumns(clusterRows(pages[0] ?? [])) !== null,
	parse: parseGeneric
};
