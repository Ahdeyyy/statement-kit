// Generic table extraction from vector ruling lines — the "lattice"/"lines"
// strategy (cf. tabula lattice mode and pdfplumber's lines strategy), the
// counterpart to the text/gutter strategy in `pdf-table.ts`.
//
// Where `pdf-table.ts` *infers* columns from the alignment of words (and rows
// from y-clustering), this extractor reads them straight off the table's drawn
// borders: the horizontal rules are the row boundaries and the vertical rules
// are the column boundaries, so every cell is the rectangle between two adjacent
// rules. This is more reliable than gutter detection whenever the statement
// actually draws its grid (right-aligned numerics, ragged descriptions and
// blank cells no longer confuse column detection), and useless when it doesn't
// — hence it runs alongside, not instead of, the text strategy.
//
// Rulings arrive already rotation-normalised and in the same PDF-point, y-up
// frame as the text items (see `pdf-shared.ts`); the browser pipeline (`pdf.ts`)
// recovers them from the page's drawing operators. The output is the same plain
// `string[][]` grid that `extractFromGrid` maps to transactions, so this path
// reuses the same field-mapping as CSV, XLS and the text strategy.

import { type Item, type Ruling } from './pdf-shared.js';
import { matchHeader } from './grid.js';
import { NOISE_ROW, type ExtractedTable } from './pdf-table.js';

/** A rule reduced to one axis: `pos` is the constant coordinate, `lo`..`hi` the
 *  extent along the other axis. */
type Oriented = { pos: number; lo: number; hi: number };

/** Max deviation (pts) for a segment to count as axis-aligned. */
const ORIENT_TOL = 2;
/** Shortest segment (pts) kept as a ruling, so glyph strokes and tick marks
 *  don't masquerade as table borders. */
const MIN_LINE_LEN = 10;
/** Rules whose constant coordinate is within this (pts) are the same grid line
 *  (double-stroked borders, slight overdraw). */
const CLUSTER_TOL = 4;

/**
 * Split rulings into the horizontal and vertical, axis-aligned ones, dropping
 * diagonals and segments shorter than {@link MIN_LINE_LEN}.
 */
export function splitRulings(rulings: Ruling[]): {
	horizontals: Oriented[];
	verticals: Oriented[];
} {
	const horizontals: Oriented[] = [];
	const verticals: Oriented[] = [];
	for (const r of rulings) {
		const dx = Math.abs(r.x2 - r.x1);
		const dy = Math.abs(r.y2 - r.y1);
		if (dy <= ORIENT_TOL && dx >= MIN_LINE_LEN) {
			horizontals.push({
				pos: (r.y1 + r.y2) / 2,
				lo: Math.min(r.x1, r.x2),
				hi: Math.max(r.x1, r.x2)
			});
		} else if (dx <= ORIENT_TOL && dy >= MIN_LINE_LEN) {
			verticals.push({
				pos: (r.x1 + r.x2) / 2,
				lo: Math.min(r.y1, r.y2),
				hi: Math.max(r.y1, r.y2)
			});
		}
	}
	return { horizontals, verticals };
}

/**
 * Collapse near-equal rule positions into one grid line each (their mean),
 * returned ascending. These are the row/column boundaries the cells sit between.
 */
export function gridLines(lines: Oriented[]): number[] {
	const sorted = lines.map((l) => l.pos).sort((a, b) => a - b);
	const out: number[] = [];
	let group: number[] = [];
	for (const p of sorted) {
		if (group.length === 0 || p - group[group.length - 1] <= CLUSTER_TOL) {
			group.push(p);
		} else {
			out.push(group.reduce((s, v) => s + v, 0) / group.length);
			group = [p];
		}
	}
	if (group.length > 0) out.push(group.reduce((s, v) => s + v, 0) / group.length);
	return out;
}

/** Band index whose [boundaries[j], boundaries[j+1]) contains `value`, or -1
 *  when `value` falls outside the outermost boundaries (i.e. off the table). */
function bandOf(value: number, boundaries: number[]): number {
	for (let j = 0; j < boundaries.length - 1; j++) {
		if (value >= boundaries[j] && value < boundaries[j + 1]) return j;
	}
	return -1;
}

/**
 * Turn one page's items + rulings into a grid by binning each item into the cell
 * (row band × column band) its position lands in. Rows are emitted top of page
 * first; an item is placed by its baseline y and its horizontal centre. Returns
 * `[]` when the page lacks a 2×2 grid of rules (nothing to read).
 */
export function pageToGridByLines(items: Item[], rulings: Ruling[]): string[][] {
	const { horizontals, verticals } = splitRulings(rulings);
	const xs = gridLines(verticals); // ascending: column boundaries
	const ys = gridLines(horizontals); // ascending: row boundaries
	if (xs.length < 2 || ys.length < 2) return [];

	const colCount = xs.length - 1;
	// Row bands top of page first (y grows upward, so descending y).
	const rowTops = [...ys].sort((a, b) => b - a);

	const grid: string[][] = [];
	for (let ri = 0; ri < rowTops.length - 1; ri++) {
		const top = rowTops[ri];
		const bottom = rowTops[ri + 1];
		const cellItems: Item[][] = Array.from({ length: colCount }, () => []);
		for (const it of items) {
			// Baseline within (bottom, top]; centre within the table's x-extent.
			if (!(it.y > bottom && it.y <= top)) continue;
			const col = bandOf(it.x + it.width / 2, xs);
			if (col === -1) continue;
			cellItems[col].push(it);
		}
		const cells = cellItems.map((items) =>
			[...items]
				.sort((a, b) => a.x - b.x)
				.map((i) => i.text.trim())
				.join(' ')
				.replace(/\s+/g, ' ')
				.trim()
		);
		if (cells.some((c) => c !== '')) grid.push(cells);
	}
	return grid;
}

/**
 * Extract a single table from a statement's pages using their ruling lines. Each
 * page is gridded on its own rules (statements repeat their geometry, so the
 * column count is stable); footer noise and reprinted header rows are dropped.
 * Returns the header row at index 0 followed by data rows, or `headerRowIndex:
 * -1` with data only when no header band could be recognised.
 */
export function extractTableByLines(pages: Item[][], rulings: Ruling[][]): ExtractedTable {
	let headerCells: string[] | null = null;
	const dataRows: string[][] = [];

	for (let p = 0; p < pages.length; p++) {
		const grid = pageToGridByLines(pages[p] ?? [], rulings[p] ?? []);
		for (const cells of grid) {
			if (NOISE_ROW.test(cells.join(' '))) continue;
			if (matchHeader(cells) !== null) {
				// Keep the first header; drop it and any reprinted copies as data.
				if (headerCells === null) headerCells = cells;
				continue;
			}
			dataRows.push(cells);
		}
	}

	const grid: string[][] = [];
	if (headerCells !== null) grid.push(headerCells);
	grid.push(...dataRows);
	return { grid, headerRowIndex: headerCells !== null ? 0 : -1 };
}

/** True when some page's line grid carries a recognisable table header. */
export function hasLineHeader(pages: Item[][], rulings: Ruling[][]): boolean {
	for (let p = 0; p < pages.length; p++) {
		const grid = pageToGridByLines(pages[p] ?? [], rulings[p] ?? []);
		if (grid.some((cells) => matchHeader(cells) !== null)) return true;
	}
	return false;
}
