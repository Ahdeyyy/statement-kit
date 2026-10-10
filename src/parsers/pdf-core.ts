// PDF statement parsing entry point. Holds no bank-specific logic itself: it
// dispatches the rotation-normalised pages to the first registered
// {@link PdfStatementParser} whose `detect` recognises the layout. Adding a new
// bank with an incompatible layout means writing a `pdf-<bank>.ts` parser and
// listing it here — no changes to existing parsers.

import type { ParseResult } from './types.js';
import { type Item, type Ruling } from './pdf-shared.js';
import { zenithParser } from './pdf-zenith.js';
import { gtbankParser } from './pdf-gtbank.js';
import { cowrywiseParser } from './pdf-cowrywise.js';
import { ubaParser } from './pdf-uba.js';
import { genericParser } from './pdf-generic.js';
import { genericLinesParser } from './pdf-generic-lines.js';

export { normalizeRotation, normalizeRulings, type Item, type Ruling } from './pdf-shared.js';

// Order matters: the first parser to `detect` the document wins. The tuned
// per-bank layouts (and GTBank's header-driven layout) are authoritative and run
// first. The two layout-agnostic generic parsers are the fallback: the
// line/lattice one is preferred when the page actually draws its table borders
// (more reliable than gutter inference), with the text/gutter one behind it.
const TUNED = [zenithParser, cowrywiseParser, ubaParser, gtbankParser];

/**
 * @param opts.rulings vector ruling lines per page (index-aligned with `pages`),
 * enabling the line/lattice generic fallback. Empty/omitted when the upstream
 * pipeline couldn't recover any, in which case only the text strategies run.
 * @param opts.force ignore each parser's `detect` and run them all, returning
 * the result with the most rows. Used for the "try other parsers anyway" path:
 * when no parser recognised the layout, the user can opt to parse on a best
 * guess (which may be inaccurate) rather than give up.
 */
export function parsePdfItems(
	pages: Item[][],
	opts?: { force?: boolean; rulings?: Ruling[][] }
): ParseResult {
	const rulings = opts?.rulings ?? [];
	if (opts?.force) {
		let best: ParseResult | null = null;
		const consider = (result: ParseResult) => {
			if (result.rows.length > 0 && (best === null || result.rows.length > best.rows.length)) {
				best = result;
			}
		};
		for (const parser of TUNED) consider(parser.parse(pages));
		consider(genericLinesParser.parse(pages, rulings));
		consider(genericParser.parse(pages));
		return (
			best ?? {
				rows: [],
				meta: {},
				warnings: ['None of the available parsers could read this PDF.']
			}
		);
	}
	for (const parser of TUNED) {
		if (parser.detect(pages)) return parser.parse(pages);
	}
	// No tuned parser matched: prefer the lattice generic when the page draws its
	// borders, else the gutter generic. The gutter generic also runs last as the
	// final fallback so the user still gets a helpful warning when it can't find
	// a table either.
	if (genericLinesParser.detect(pages, rulings)) return genericLinesParser.parse(pages, rulings);
	if (genericParser.detect(pages)) return genericParser.parse(pages);
	return genericParser.parse(pages);
}
