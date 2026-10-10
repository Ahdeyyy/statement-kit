// Shared helpers for the PDF statement parsers, operating on positioned text
// items. Kept free of pdf.js imports so parsers can run (and be tested)
// anywhere. Each bank gets its own {@link PdfStatementParser}; the dispatcher in
// `pdf-core.ts` picks the first one whose `detect` recognises the document, so a
// new bank with an incompatible layout is a new file rather than another branch
// in a shared routine.

import type { ParseResult } from './types.js';

export type Item = { text: string; x: number; y: number; width: number };
export type VisualRow = { y: number; items: Item[] };

/**
 * A straight vector ruling line drawn on the page (a table border), expressed in
 * the same upright PDF-point, y-up frame as {@link Item}. The "lattice"/"lines"
 * table strategy (see `pdf-table-lines.ts`) reads rows and columns from these
 * rules; the text/gutter strategy (`pdf-table.ts`) ignores them.
 */
export type Ruling = { x1: number; y1: number; x2: number; y2: number };

/** Items within this many points of each other (vertically) are one row. */
export const Y_TOLERANCE = 3;

/**
 * A bank-specific statement parser. `detect` runs against the (rotation-
 * normalised) pages and returns true when this parser recognises the layout;
 * `parse` then turns the pages into transactions. Parsers should be cheap and
 * side-effect free so the dispatcher can try several in turn.
 */
export type PdfStatementParser = {
	/** Human-readable bank/layout name, for diagnostics. */
	name: string;
	detect: (pages: Item[][]) => boolean;
	parse: (pages: Item[][]) => ParseResult;
};

/**
 * A statement parser that also consumes the page's vector ruling lines (one
 * {@link Ruling} array per page, index-aligned with `pages`). Used by the
 * lattice/"lines" generic extractor, which needs the drawn table borders the
 * text-only {@link PdfStatementParser} never sees.
 */
export type LinedPdfStatementParser = {
	name: string;
	detect: (pages: Item[][], rulings: Ruling[][]) => boolean;
	parse: (pages: Item[][], rulings: Ruling[][]) => ParseResult;
};

/**
 * Re-express positioned items in an upright, left-to-right / y-up frame,
 * undoing a page's /Rotate. Long-form GTBank statements are emitted on
 * 90°-rotated pages (fields stack down the y-axis at a fixed x, records run
 * along x); normalising lets them parse with the same column logic as upright
 * statements. `x`/`y` are the PDF text-origin (transform[4]/[5]); `width` is the
 * glyph advance along the reading direction, which stays the new x-extent.
 */
export function normalizeRotation(items: Item[], rotate: number): Item[] {
	const r = (((rotate ?? 0) % 360) + 360) % 360;
	if (r === 0) return items;
	return items.map((it) => {
		switch (r) {
			case 90:
				return { text: it.text, x: it.y, y: -it.x, width: it.width };
			case 180:
				return { text: it.text, x: -it.x, y: -it.y, width: it.width };
			case 270:
				return { text: it.text, x: -it.y, y: it.x, width: it.width };
			default:
				return it;
		}
	});
}

/**
 * Apply the same /Rotate normalisation as {@link normalizeRotation} to vector
 * ruling lines, transforming both endpoints so the rules stay aligned with the
 * (already normalised) text items they border.
 */
export function normalizeRulings(rulings: Ruling[], rotate: number): Ruling[] {
	const r = (((rotate ?? 0) % 360) + 360) % 360;
	if (r === 0) return rulings;
	const point = (x: number, y: number): [number, number] => {
		switch (r) {
			case 90:
				return [y, -x];
			case 180:
				return [-x, -y];
			case 270:
				return [-y, x];
			default:
				return [x, y];
		}
	};
	return rulings.map(({ x1, y1, x2, y2 }) => {
		const [nx1, ny1] = point(x1, y1);
		const [nx2, ny2] = point(x2, y2);
		return { x1: nx1, y1: ny1, x2: nx2, y2: ny2 };
	});
}

/** Group items into visual rows by y-proximity, sorted top of page first. */
export function clusterRows(items: Item[]): VisualRow[] {
	const rows: VisualRow[] = [];
	// PDF y grows upward: sort top of page first.
	const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
	for (const item of sorted) {
		const last = rows[rows.length - 1];
		if (last !== undefined && Math.abs(last.y - item.y) <= Y_TOLERANCE) {
			last.items.push(item);
		} else {
			rows.push({ y: item.y, items: [item] });
		}
	}
	for (const row of rows) row.items.sort((a, b) => a.x - b.x);
	return rows;
}

/** Flatten a page's items into a single newline-joined text blob for meta regexes. */
export function pageText(rows: VisualRow[]): string {
	return rows.map((r) => r.items.map((i) => i.text).join(' ')).join('\n');
}

/** Map a statement's currency label to an ISO code, or undefined if unknown. */
export function normalizeCurrency(raw: string): string | undefined {
	if (/naira|\bNGN\b|₦/i.test(raw)) return 'NGN';
	if (/dollar|\bUSD\b|\$/i.test(raw)) return 'USD';
	if (/pound|sterling|\bGBP\b|£/i.test(raw)) return 'GBP';
	if (/euro|\bEUR\b|€/i.test(raw)) return 'EUR';
	const code = /^\s*([A-Za-z]{3})\b/.exec(raw);
	return code ? code[1].toUpperCase() : undefined;
}
