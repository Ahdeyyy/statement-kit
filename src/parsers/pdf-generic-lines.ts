// Layout-agnostic statement parser that reads the table from the page's vector
// ruling lines (the "lattice"/"lines" strategy) instead of from word alignment.
// It is the line-aware sibling of `pdf-generic.ts`: same field mapping
// (`grid.ts`) and same best-effort metadata, but the grid comes from
// `extractTableByLines` rather than `extractTable`. Used as a fallback for
// statements that draw their table borders — common bordered layouts the
// gutter-based generic parser mis-columns (right-aligned numerics, blank cells)
// read cleanly here. Like the text generic, the tuned parsers stay authoritative
// for their banks.

import type { ParseResult } from './types.js';
import {
	clusterRows,
	pageText,
	type Item,
	type LinedPdfStatementParser,
	type Ruling
} from './pdf-shared.js';
import { extractFromGrid } from './grid.js';
import { extractTableByLines, hasLineHeader } from './pdf-table-lines.js';
import { extractMeta } from './pdf-generic.js';

function parseGenericLines(pages: Item[][], rulings: Ruling[][]): ParseResult {
	const { grid } = extractTableByLines(pages, rulings);
	const result = extractFromGrid(grid);
	const meta = pages.length > 0 ? extractMeta(pageText(clusterRows(pages[0]))) : {};
	return { ...result, meta: { ...meta, ...result.meta } };
}

export const genericLinesParser: LinedPdfStatementParser = {
	name: 'generic-lines',
	detect: (pages, rulings) => hasLineHeader(pages, rulings),
	parse: parseGenericLines
};
