// Generic table extraction from positioned PDF text. Implements the
// "stream"/"text" strategy (cf. tabula stream mode and pdfplumber's text
// strategy): columns are inferred from the alignment of words, because the
// upstream pipeline (`pdf.ts`) keeps only text items and discards the vector
// ruling lines a "lattice"/"lines" strategy would need.
//
// Two column-detection methods, header-anchored preferred:
//   1. Header-anchored — find the row that reads as a table header (reusing
//      grid.ts's `matchHeader`), then seed one column per header label. Most
//      reliable for statements, which are header-driven.
//   2. Whitespace gutters — when no header is found, treat persistently blank
//      vertical x-ranges (channels never covered by any word) as the column
//      separators.
//
// The output is a plain `string[][]` grid that `extractFromGrid` maps to
// transactions, so PDF reuses the same field-mapping path as CSV and XLS.

import { clusterRows, type Item, type VisualRow } from './pdf-shared.js';
import { matchHeader } from './grid.js';
import { parseStatementDate } from './values.js';

export type ExtractedTable = { grid: string[][]; headerRowIndex: number };

// Footer/summary lines that aren't transactions; dropped before binning so a
// stray total doesn't appear as a row or skew column detection.
export const NOISE_ROW =
	/page\s*\d+\s*of\s*\d+|opening balance|closing balance|brought forward|carried forward|total debit|total credit|statement period|computer generated|e&oe/i;

/** Header-label centres closer than this collapse into one column seed, so a
 *  label split across items ("Trans" + "Date") stays a single column. */
const SEED_MERGE = 14;
/** Minimum width (pts) of a blank vertical channel counted as a column gap. */
const MIN_GUTTER = 6;

/** Centre x of a positioned item. */
function center(it: Item): number {
	return it.x + it.width / 2;
}

/** Collapse near-equal sorted positions into their group means. */
function clusterPositions(positions: number[], threshold: number): number[] {
	const sorted = [...positions].sort((a, b) => a - b);
	const seeds: number[] = [];
	let group: number[] = [];
	for (const p of sorted) {
		if (group.length === 0 || p - group[group.length - 1] <= threshold) {
			group.push(p);
		} else {
			seeds.push(group.reduce((s, v) => s + v, 0) / group.length);
			group = [p];
		}
	}
	if (group.length > 0) seeds.push(group.reduce((s, v) => s + v, 0) / group.length);
	return seeds;
}

/** Midpoints between adjacent column seeds, used as bin boundaries. */
function sepsFromSeeds(seeds: number[]): number[] {
	const seps: number[] = [];
	for (let i = 1; i < seeds.length; i++) seps.push((seeds[i - 1] + seeds[i]) / 2);
	return seps;
}

/**
 * Find the first visual row that reads as a table header and seed one column per
 * header label. Header recognition reuses grid.ts's {@link matchHeader} so PDF,
 * CSV and XLS agree on what counts as a header; seeds come from every item in the
 * row (not just the matched ones) so unrelated columns still get their own bin
 * and don't merge into a labelled one.
 */
export function findHeaderColumns(rows: VisualRow[]): { rowIndex: number; seeds: number[] } | null {
	for (let i = 0; i < rows.length; i++) {
		if (matchHeader(rows[i].items.map((it) => it.text)) === null) continue;
		const seeds = clusterPositions(rows[i].items.map(center), SEED_MERGE);
		if (seeds.length >= 2) return { rowIndex: i, seeds };
	}
	return null;
}

/**
 * Whitespace-gutter column detection (tabula "stream" / pdfplumber "text"): merge
 * every item's x-extent across all rows, then treat blank channels wider than
 * {@link MIN_GUTTER} between the merged blobs as column separators. Used when no
 * header row is recognised.
 */
export function detectColumnsByGutters(rows: VisualRow[]): number[] {
	const intervals: [number, number][] = [];
	for (const row of rows) {
		for (const it of row.items) {
			intervals.push([it.x, it.x + Math.max(it.width, 1)]);
		}
	}
	if (intervals.length === 0) return [];
	intervals.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [l, r] of intervals) {
		const last = merged[merged.length - 1];
		if (last !== undefined && l <= last[1]) last[1] = Math.max(last[1], r);
		else merged.push([l, r]);
	}
	const seps: number[] = [];
	for (let i = 1; i < merged.length; i++) {
		if (merged[i][0] - merged[i - 1][1] >= MIN_GUTTER) {
			seps.push((merged[i - 1][1] + merged[i][0]) / 2);
		}
	}
	return seps;
}

/**
 * Column separators for a page: header-anchored when a header row is found (most
 * reliable), otherwise whitespace gutters.
 */
export function detectColumns(rows: VisualRow[]): number[] {
	const header = findHeaderColumns(rows);
	if (header !== null) return sepsFromSeeds(header.seeds);
	return detectColumnsByGutters(rows);
}

/** Column index for an x value given sorted separators. */
function binOf(x: number, seps: number[]): number {
	let i = 0;
	while (i < seps.length && x >= seps[i]) i++;
	return i;
}

/**
 * Bin each row's items into columns by their centre x and join the items in a
 * cell left-to-right. Empty cells become "" so every grid row has the same
 * column count ({@link matchHeader}/extractFromGrid index cells positionally).
 */
export function rowsToGrid(rows: VisualRow[], seps: number[]): string[][] {
	const colCount = seps.length + 1;
	return rows.map((row) => {
		const cells: string[] = Array.from({ length: colCount }, () => '');
		for (const it of [...row.items].sort((a, b) => a.x - b.x)) {
			const col = binOf(center(it), seps);
			const text = it.text.trim();
			cells[col] = cells[col] === '' ? text : `${cells[col]} ${text}`;
		}
		return cells.map((c) => c.replace(/\s+/g, ' ').trim());
	});
}

/**
 * Join a block of visual rows into a single grid row, binning every item by its
 * centre x and concatenating each column's fragments in reading order (top line
 * first, then left to right). Used to fold a multi-row record into one row.
 */
function blockToCells(block: VisualRow[], seps: number[]): string[] {
	const cells: string[] = Array.from({ length: seps.length + 1 }, () => '');
	const items = block.flatMap((r) => r.items).sort((a, b) => b.y - a.y || a.x - b.x);
	for (const it of items) {
		const text = it.text.trim();
		if (text === '') continue;
		const col = binOf(center(it), seps);
		cells[col] = cells[col] === '' ? text : `${cells[col]} ${text}`;
	}
	return cells.map((c) => c.replace(/\s+/g, ' ').trim());
}

/**
 * Fold multi-row records on one page into a single grid row each. On landscape
 * long-form statements a transaction spans several visual rows because its
 * description (and reference) wraps across lines vertically offset from — and
 * often centred on — the row carrying the date and amount, so the plain
 * one-visual-row-per-record mapping loses the description and splits references.
 *
 * Group the rows into blocks by vertical spacing (the gap between records is
 * wider than the line spacing within a description) and fold each block that
 * holds exactly one date-bearing "anchor" row into one grid row. Blocks with no
 * anchor (metadata, stray text) or several anchors (single-line records that
 * share no separating gap) are emitted row by row, so upright single-line
 * statements grid exactly as before. Skipped entirely when no header column
 * layout is known (so there is no date column to find anchors by).
 */
function mergePageRecords(rows: VisualRow[], seps: number[], dateCol: number | null): string[][] {
	if (dateCol === null || rows.length === 0) return rowsToGrid(rows, seps);
	const sorted = [...rows].sort((a, b) => b.y - a.y);
	const isAnchor = (row: VisualRow) =>
		parseStatementDate(rowsToGrid([row], seps)[0][dateCol] ?? '') !== null;

	const anchorYs = sorted.filter(isAnchor).map((r) => r.y);
	if (anchorYs.length === 0) return sorted.map((r) => rowsToGrid([r], seps)[0]);

	// Block-separation threshold from the gaps inside the transaction region only
	// (between the first and last anchor, plus a margin for descriptions that
	// overrun them), so metadata/footer spacing above and below can't skew it. The
	// line height and the record gap are close, so find the widest jump between
	// consecutive sorted gaps and split at its midpoint; a sub-line-height floor
	// keeps stray fragment gaps out of the estimate. No clear jump ⇒ one block.
	const top = Math.max(...anchorYs) + 20;
	const bottom = Math.min(...anchorYs) - 20;
	const gaps: number[] = [];
	for (let i = 1; i < sorted.length; i++) {
		const hi = sorted[i - 1].y;
		const lo = sorted[i].y;
		const gap = hi - lo;
		if (gap > 0.5 && gap <= 30 && lo >= bottom && hi <= top) gaps.push(gap);
	}
	gaps.sort((a, b) => a - b);
	const median = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;
	const spacing = gaps.filter((g) => g >= median * 0.6);
	let blockGap = Infinity;
	let widestJump = 0;
	for (let i = 1; i < spacing.length; i++) {
		const jump = spacing[i] - spacing[i - 1];
		if (jump >= 2 && jump > widestJump) {
			widestJump = jump;
			blockGap = (spacing[i] + spacing[i - 1]) / 2;
		}
	}

	const out: string[][] = [];
	let block: VisualRow[] = [];
	const flush = () => {
		if (block.length === 0) return;
		if (block.filter(isAnchor).length === 1) out.push(blockToCells(block, seps));
		else for (const row of block) out.push(rowsToGrid([row], seps)[0]);
		block = [];
	};
	for (let i = 0; i < sorted.length; i++) {
		if (i > 0 && sorted[i - 1].y - sorted[i].y > blockGap) flush();
		block.push(sorted[i]);
	}
	flush();
	return out;
}

/**
 * Extract a single table from the (rotation-normalised) pages of a statement.
 * The header found on the first page that has one drives every page's columns
 * (statements repeat their geometry); footer noise and reprinted header rows are
 * dropped, and multi-row records are folded into one row each. Returns the header
 * row at index 0 followed by data rows, or `headerRowIndex: -1` with data only
 * when no header could be located.
 */
export function extractTable(pages: Item[][]): ExtractedTable {
	const pageRows = pages.map((p) => clusterRows(p));

	let seps: number[] | null = null;
	let headerCells: string[] | null = null;
	for (const rows of pageRows) {
		const header = findHeaderColumns(rows);
		if (header !== null) {
			seps = sepsFromSeeds(header.seeds);
			headerCells = rowsToGrid([rows[header.rowIndex]], seps)[0];
			break;
		}
	}
	if (seps === null) seps = detectColumnsByGutters(pageRows[0] ?? []);
	// Date column (when a header was recognised) locates the anchor row of each
	// multi-row record; without it, records are left one-row-per-line.
	const dateCol = headerCells !== null ? (matchHeader(headerCells)?.date ?? null) : null;

	const grid: string[][] = [];
	if (headerCells !== null) grid.push(headerCells);
	for (const rows of pageRows) {
		const dataRows = rows.filter((row) => {
			const texts = row.items.map((i) => i.text);
			// Drop footer noise and the header row (and its reprints on later pages).
			return !NOISE_ROW.test(texts.join(' ')) && matchHeader(texts) === null;
		});
		grid.push(...mergePageRecords(dataRows, seps, dateCol));
	}
	return { grid, headerRowIndex: headerCells !== null ? 0 : -1 };
}
