// GTBank statement parser (also serves as the generic fallback for any
// header-driven Debit/Credit/Balance layout).
//
// Strategy: locate the header row (Debit(s) / Credit(s) / Balance / Remarks) to
// learn column x positions, deriving column order from the header layout so the
// same logic handles GTBank's short- and long-form variants (which reorder the
// date/reference columns and add an Originating Branch column). On the landscape
// long-form the header labels are centred over wide columns while the data is
// left-aligned, so a text column's left boundary is taken midway toward the
// previous header rather than hugging its label. Every numeric in the Balance
// column anchors one record; the debit-or-credit numeric on the same visual line
// gives the amount; date and reference fragments are attached by y-proximity
// (wrapped dates straddle the balance line); remark lines are grouped into
// per-record blocks by vertical spacing and each block goes to the anchor whose
// balance row sits inside it — this handles both a description that wraps
// downward from its balance line and one centred on the row (whose top lines then
// sit above the balance). Debit-vs-credit is resolved primarily by the running
// balance delta (statements report a balance on every row and an opening balance
// in the header), falling back to column x.
//
// Long-form statements may arrive on 90°-rotated pages (or already upright in
// landscape); the dispatcher normalises rotation before parsing so this column
// logic applies unchanged.

import type { ParsedTransaction, ParseResult, StatementMeta } from './types.js';
import { parseStatementDate, parseAmount, cents } from './values.js';
import {
	clusterRows,
	normalizeCurrency,
	pageText,
	Y_TOLERANCE,
	type Item,
	type PdfStatementParser,
	type VisualRow
} from './pdf-shared.js';

type Columns = {
	dateLeft: number;
	dateRight: number;
	refLeft: number;
	refRight: number;
	debitRight: number;
	creditRight: number;
	balanceRight: number;
	remarksLeft: number;
	/** Left edge of the "Originating Branch" column, when present (long-form
	 *  GTBank statements). Items at or past it are branch names, not amounts. */
	branchLeft?: number;
};

/** Max distance between a numeric's right edge and a column's right edge. */
const COLUMN_SNAP = 35;
/** Date/reference fragments must sit within this many points of the anchor. */
const NEAR_ANCHOR = 10;
const NOISE_ROW =
	/page:\s*\d+\s*of\s*\d+|customer statement|opening balance|closing balance|usable balance|total debit|total credit|debit count|credit count|print date|account type|branch name|statement period|computer generated|guaranty trust|customer information unit/i;

function findColumns(rows: VisualRow[]): { columns: Columns; headerY: number } | null {
	for (let i = 0; i < rows.length; i++) {
		const cells = rows[i].items;
		// "Debits"/"Credits" (plural) on long-form statements, singular on short ones.
		const debit = cells.find((c) => /^debits?$/i.test(c.text.trim()));
		const credit = cells.find((c) => /^credits?$/i.test(c.text.trim()));
		const balance = cells.find((c) => /^balance$/i.test(c.text.trim()));
		if (!debit || !credit || !balance) continue;

		// Labelled headers can wrap onto neighbouring rows; the date/reference
		// columns also appear in different orders across statement variants
		// (short: Trans|Reference|Value; long: Trans|Value|Reference|...|Branch),
		// so derive column boundaries from header positions rather than a fixed
		// order.
		let trans: Item | undefined;
		let reference: Item | undefined;
		let value: Item | undefined;
		let branch: Item | undefined;
		let remarks: Item | undefined;
		for (let j = Math.max(0, i - 2); j < Math.min(rows.length, i + 3); j++) {
			for (const c of rows[j].items) {
				const t = c.text.trim();
				if (/^trans\b/i.test(t) && trans === undefined) trans = c;
				if (/^reference$/i.test(t) && reference === undefined) reference = c;
				if (/^value\b/i.test(t) && value === undefined) value = c;
				if (/^(originating|branch)\b/i.test(t) && branch === undefined) branch = c;
				if (/^(remarks|narration|description)/i.test(t) && remarks === undefined) remarks = c;
			}
		}

		// First labelled column strictly to the right of `x` (column boundaries
		// fall just before the next column begins).
		const headerXs = [trans, value, reference, debit, credit, balance, branch, remarks]
			.filter((c): c is Item => c !== undefined)
			.map((c) => c.x);
		const nextRight = (x: number): number | undefined =>
			headerXs.filter((hx) => hx > x + 1).sort((a, b) => a - b)[0];
		const nextLeft = (x: number): number | undefined =>
			headerXs.filter((hx) => hx < x - 1).sort((a, b) => b - a)[0];
		// Left boundary of a text column (reference/remarks). On the landscape
		// long-form variant the header labels are centred over wide columns whose
		// data is left-aligned, so the data sits well left of its label and a tight
		// `header.x - 8` edge would miss it. Fall to the midpoint toward the previous
		// column's header instead; that reaches the data without crossing into the
		// previous column, whose own data is matched first so any overlap is
		// harmless.
		const leftEdge = (x: number, tight: number): number => {
			const prev = nextLeft(x);
			return prev === undefined ? tight : (x + prev) / 2;
		};

		const dateLeft = (trans?.x ?? 0) - 15;
		const dateRight = trans !== undefined ? (nextRight(trans.x) ?? trans.x + 60) - 8 : 60;
		const refLeft = reference !== undefined ? leftEdge(reference.x, reference.x - 8) : dateRight;
		const refRight =
			reference !== undefined
				? (nextRight(reference.x) ?? reference.x + 100) - 8
				: value !== undefined
					? value.x - 8
					: dateRight + 100;
		return {
			headerY: rows[i].y,
			columns: {
				dateLeft,
				dateRight,
				refLeft,
				refRight,
				debitRight: debit.x + debit.width,
				creditRight: credit.x + credit.width,
				balanceRight: balance.x + balance.width,
				remarksLeft:
					remarks !== undefined ? leftEdge(remarks.x, remarks.x - 10) : balance.x + balance.width + 20,
				branchLeft: branch !== undefined ? branch.x - 8 : undefined
			}
		};
	}
	return null;
}

function extractMeta(text: string): StatementMeta {
	const meta: StatementMeta = {};
	let m = /account\s*(?:number|no\.?)\s*:?\s*(\d{2,}[xX*]+\d{2,}|\d{6,})\b/i.exec(text);
	if (m) meta.accountNumber = m[1];
	// Currency may be an ISO code ("NGN") or a full name ("NIGERIAN NAIRA").
	m = /currency\s*:?\s*([A-Za-z][A-Za-z ]{0,30})/i.exec(text);
	if (m) {
		const currency = normalizeCurrency(m[1]);
		if (currency !== undefined) meta.currency = currency;
	}
	m = /opening\s*balance\s*:?\s*([\d,]+\.?\d*)/i.exec(text);
	if (m) meta.openingBalance = parseAmount(m[1]) ?? undefined;
	m = /(?:statement\s+)?\bperiod\s*:?\s*(.+?)\s*(?=\s+opening\s+balance\b|\n|$)/i.exec(text);
	if (m) meta.period = m[1].trim();
	// Long-form statements print the account holder under "CUSTOMER STATEMENT".
	// The name may not be the very next line — a left-column field ("Opening
	// Balance  62,114.29") can sort between — so scan the following text for the
	// first line that is two or more all-caps words, skipping mixed-case labels.
	m = /customer\s+statement/i.exec(text);
	if (m) {
		const after = text.slice(m.index + m[0].length);
		const name = /(?:^|\n)\s*([A-Z][A-Z'.-]+(?: [A-Z][A-Z'.-]+)+)\s*(?=\n|$)/.exec(after);
		if (name) meta.accountName = name[1].trim();
	}
	return meta;
}

type Fragment = { y: number; x: number; text: string };

type Anchor = {
	page: number;
	y: number;
	balance: number;
	amountAbs: number | null;
	amountRight: number | null;
	dateParts: Fragment[];
	/** Date fragments from a repeated copy of this record on the next page. */
	altDateParts?: Fragment[];
	refParts: Fragment[];
	/** Remark fragments, tagged with their source page so a description that
	 *  wraps past a page break orders correctly across the boundary. */
	remarkParts: (Fragment & { page: number })[];
};

function parseGtbank(pages: Item[][]): ParseResult {
	const warnings: string[] = [];
	let meta: StatementMeta = {};
	let columns: Columns | null = null;
	const anchors: Anchor[] = [];
	// Remark fragments that overflowed to the top of a page with no anchor above
	// them; tagged with page and resolved once every page's anchors are known.
	const orphans: { page: number; y: number; x: number; text: string }[] = [];
	// Reading order as one scalar: page ascending, then y descending (PDF y grows
	// upward). Larger == earlier/above; the per-page offset dwarfs any in-page y
	// so pages never overlap. Used to order remark fragments that span a page
	// break within a single record.
	const readingY = (page: number, y: number) => -page * 100000 + y;

	for (let pageNum = 1; pageNum <= pages.length; pageNum++) {
		const rows = clusterRows(pages[pageNum - 1]);

		if (pageNum === 1) {
			meta = extractMeta(pageText(rows));
		}

		const found = findColumns(rows);
		let headerY = Infinity;
		if (found !== null) {
			columns = found.columns;
			headerY = found.headerY;
		}
		if (columns === null) continue;
		const cols = columns;

		// Items in data territory, with meta/footer rows dropped wholesale.
		const dataRows = rows.filter(
			(row) =>
				row.y < headerY - Y_TOLERANCE && !NOISE_ROW.test(row.items.map((i) => i.text).join(' '))
		);

		const dates: Fragment[] = [];
		const refs: Fragment[] = [];
		const remarkItems: Fragment[] = [];
		const amounts: { y: number; right: number; value: number }[] = [];
		const balances: { y: number; value: number }[] = [];

		for (const row of dataRows) {
			for (const item of row.items) {
				const text = item.text.trim();
				if (item.x >= cols.dateLeft && item.x < cols.dateRight) {
					dates.push({ y: item.y, x: item.x, text });
					continue;
				}
				if (item.x >= cols.refLeft && item.x < cols.refRight) {
					refs.push({ y: item.y, x: item.x, text: text.replace(/^'/, '') });
					continue;
				}
				if (item.x >= cols.remarksLeft - 5) {
					remarkItems.push({ y: item.y, x: item.x, text });
					continue;
				}
				// Originating-branch names ("635 AKIN ADESOLA") sit between balance
				// and remarks; ignore them so a leading "635" is never read as an amount.
				if (cols.branchLeft !== undefined && item.x >= cols.branchLeft) continue;
				const numeric = /^[\d,]*\.?\d+$/.test(text) ? parseAmount(text) : null;
				if (numeric === null) continue;
				const right = item.x + item.width;
				const candidates: [number, 'debit' | 'credit' | 'balance'][] = [
					[Math.abs(right - cols.debitRight), 'debit'],
					[Math.abs(right - cols.creditRight), 'credit'],
					[Math.abs(right - cols.balanceRight), 'balance']
				];
				candidates.sort((a, b) => a[0] - b[0]);
				if (candidates[0][0] > COLUMN_SNAP) continue; // e.g. a value-date year
				if (candidates[0][1] === 'balance') {
					balances.push({ y: item.y, value: numeric });
				} else {
					amounts.push({ y: item.y, right, value: Math.abs(numeric) });
				}
			}
		}

		// One record per balance value, top of page downward.
		balances.sort((a, b) => b.y - a.y);
		for (const bal of balances) {
			const amount = amounts.find((a) => Math.abs(a.y - bal.y) <= Y_TOLERANCE);
			anchors.push({
				page: pageNum,
				y: bal.y,
				balance: bal.value,
				amountAbs: amount?.value ?? null,
				amountRight: amount?.right ?? null,
				dateParts: dates.filter((d) => Math.abs(d.y - bal.y) <= NEAR_ANCHOR),
				refParts: refs.filter((r) => Math.abs(r.y - bal.y) <= NEAR_ANCHOR),
				remarkParts: []
			});
		}

		// Attach remark fragments to the record they describe. A description is a
		// contiguous run of lines spaced by the text line height; consecutive
		// records are separated by a wider gap. So split the page's remark fragments
		// into blocks at those wider gaps and give each block to the anchor whose
		// balance row sits inside it. This handles both the layout where a
		// description wraps downward from its balance line and the landscape variant
		// where it is centred on the row (some lines then sit above the balance,
		// which a plain nearest-anchor-above rule would misassign to the record
		// before it).
		//   - A block with no anchor inside is a description that wrapped across a
		//     page break; defer its fragments as orphans (resolved after all pages).
		//   - A block enclosing several anchors (records with no visible gap between
		//     descriptions) can't be split by spacing; fall back to attaching each
		//     fragment to the nearest anchor at or above it.
		const pageAnchors = anchors.filter((a) => a.page === pageNum);
		const sortedRemarks = [...remarkItems].sort((a, b) => b.y - a.y);
		// Split the fragments into per-record blocks where the vertical gap jumps
		// from the line height to the (larger) gap between records. The two are
		// close (≈9pt vs ≈14pt here), so a fixed multiple of the median gap is
		// unreliable when many single-line records make the larger gap common;
		// instead consider clear jumps between the line spacing and record padding.
		// Padding can vary by record, and a long description can have paragraph
		// gaps. Prefer the candidate producing blocks around individual balance
		// anchors; use the widest jump to break ties. When the gaps
		// form a single cluster — evenly spaced lines with no wider record
		// separation — there is no such jump, so the page stays one block and the
		// ambiguous-block fallback below assigns each fragment to its nearest anchor.
		const spacing: number[] = [];
		for (let k = 1; k < sortedRemarks.length; k++) {
			const gap = sortedRemarks[k - 1].y - sortedRemarks[k].y;
			if (gap > 0.5 && gap <= 30) spacing.push(gap);
		}
		spacing.sort((a, b) => a - b);
		let blockGap = Infinity;
		let widestJump = 0;
		let bestAmbiguity = Infinity;
		const ambiguity = (threshold: number) => {
			let score = 0;
			let start = 0;
			const firstAnchorY = pageAnchors[0]?.y ?? -Infinity;
			const consider = (end: number) => {
				const maxY = sortedRemarks[start].y;
				const minY = sortedRemarks[end - 1].y;
				const count = pageAnchors.filter(
					(a) => a.y >= minY - Y_TOLERANCE && a.y <= maxY + Y_TOLERANCE
				).length;
				// A prefix above the first balance can be a genuine page continuation.
				if (count !== 1 && !(count === 0 && minY > firstAnchorY + Y_TOLERANCE)) {
					score += end - start;
				}
			};
			for (let k = 1; k < sortedRemarks.length; k++) {
				if (sortedRemarks[k - 1].y - sortedRemarks[k].y > threshold) {
					consider(k);
					start = k;
				}
			}
			if (sortedRemarks.length > 0) consider(sortedRemarks.length);
			return score;
		};
		for (let k = 1; k < spacing.length; k++) {
			const jump = spacing[k] - spacing[k - 1];
			if (jump < 2) continue;
			const candidate = (spacing[k] + spacing[k - 1]) / 2;
			const score = ambiguity(candidate);
			if (score < bestAmbiguity || (score === bestAmbiguity && jump > widestJump)) {
				bestAmbiguity = score;
				widestJump = jump;
				blockGap = candidate;
			}
		}

		const attachBlock = (frags: Fragment[]) => {
			if (frags.length === 0) return;
			let minY = Infinity;
			let maxY = -Infinity;
			for (const f of frags) {
				if (f.y < minY) minY = f.y;
				if (f.y > maxY) maxY = f.y;
			}
			const inside = pageAnchors.filter(
				(a) => a.y >= minY - Y_TOLERANCE && a.y <= maxY + Y_TOLERANCE
			);
			if (inside.length === 1) {
				for (const f of frags) inside[0].remarkParts.push({ page: pageNum, ...f });
			} else if (inside.length === 0) {
				for (const f of frags) orphans.push({ page: pageNum, ...f });
			} else {
				for (const f of frags) {
					let above: Anchor | null = null;
					let aboveGap = Infinity;
					for (const anchor of pageAnchors) {
						const gap = anchor.y - f.y;
						if (gap >= -Y_TOLERANCE && gap < aboveGap) {
							aboveGap = gap;
							above = anchor;
						}
					}
					if (above !== null) above.remarkParts.push({ page: pageNum, ...f });
					else orphans.push({ page: pageNum, ...f });
				}
			}
		};

		let block: Fragment[] = [];
		for (let k = 0; k < sortedRemarks.length; k++) {
			if (k > 0 && sortedRemarks[k - 1].y - sortedRemarks[k].y > blockGap) {
				attachBlock(block);
				block = [];
			}
			block.push(sortedRemarks[k]);
		}
		attachBlock(block);
	}

	// Resolve fragments that overflowed to the top of a page (no anchor sat above
	// them on their own page). Two layouts produce these:
	//   - a genuine cross-page wrap: the continuation belongs to the last record
	//     of the previous page (e.g. long-form GTBank, where a remark spills onto
	//     the next page above a brand-new record), or
	//   - a page-boundary repeat: statements reprint the boundary record at the
	//     top of the next page, so its reprinted remark sits above that repeated
	//     anchor and belongs to it (the merge below then dedupes the two copies).
	// They are told apart by the same test the merge uses: a repeat shares the
	// previous page's last balance + amount.
	const firstAnchorOfPage = new Map<number, Anchor>();
	const lastAnchorOfPage = new Map<number, Anchor>();
	for (const a of anchors) {
		if (!firstAnchorOfPage.has(a.page)) firstAnchorOfPage.set(a.page, a);
		lastAnchorOfPage.set(a.page, a);
	}
	const isRepeat = (top: Anchor, prevLast: Anchor) =>
		cents(top.balance) === cents(prevLast.balance) &&
		top.amountAbs !== null &&
		prevLast.amountAbs !== null &&
		cents(top.amountAbs) === cents(prevLast.amountAbs) &&
		top.amountAbs !== 0;
	for (const orphan of orphans) {
		const top = firstAnchorOfPage.get(orphan.page) ?? null;
		const prevLast = lastAnchorOfPage.get(orphan.page - 1) ?? null;
		// Wrap continuation → previous page's last record; repeat (or no previous
		// page) → this page's top anchor, the nearest record below the fragment.
		const target = prevLast !== null && (top === null || !isRepeat(top, prevLast)) ? prevLast : top;
		if (target !== null) target.remarkParts.push(orphan);
	}

	if (columns === null) {
		return {
			rows: [],
			meta,
			warnings: ['Could not find a Debit/Credit/Balance table in this PDF.']
		};
	}

	// Statements reprint the record(s) straddling a page boundary at the top of
	// the next page (sometimes with the wrapped date split between the two
	// copies, so one copy is clipped to just "DDMon" and the other to just the
	// year). The reprinted block can be several rows deep, not just one, and a
	// clipped copy can sit on either side of the break. Two genuine consecutive
	// transactions can never share a balance unless the amount is zero, so a run
	// of (equal balance + equal non-zero amount) rows aligned across the break is
	// one set of reprinted records: fold each duplicate's fragments into the
	// original and drop the copy.
	const joinDate = (parts: Fragment[]) =>
		[...parts]
			.sort((a, b) => b.y - a.y || a.x - b.x)
			.map((p) => p.text)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();

	const sameRecord = (a: Anchor, b: Anchor) =>
		cents(a.balance) === cents(b.balance) &&
		a.amountAbs !== null &&
		b.amountAbs !== null &&
		cents(a.amountAbs) === cents(b.amountAbs) &&
		a.amountAbs !== 0;

	// Prefer whichever copy yields a parseable date; otherwise keep the original's
	// and stash the duplicate's as a fallback the date resolver also tries.
	const foldInto = (orig: Anchor, dup: Anchor) => {
		const origDate = parseStatementDate(joinDate(orig.dateParts));
		const dupDate = parseStatementDate(joinDate(dup.dateParts));
		if (origDate === null && dupDate !== null) {
			orig.altDateParts = orig.dateParts;
			orig.dateParts = dup.dateParts;
		} else {
			orig.altDateParts = dup.dateParts;
		}
		if (dup.refParts.length > orig.refParts.length) orig.refParts = dup.refParts;
		const origRemarks = orig.remarkParts.map((p) => p.text).join(' ');
		const dupRemarks = dup.remarkParts.map((p) => p.text).join(' ');
		if (dupRemarks.length > origRemarks.length) orig.remarkParts = dup.remarkParts;
	};

	const byPage = new Map<number, Anchor[]>();
	for (const a of anchors) {
		const list = byPage.get(a.page);
		if (list === undefined) byPage.set(a.page, [a]);
		else list.push(a);
	}
	const pageNums = [...byPage.keys()].sort((a, b) => a - b);
	const merged: Anchor[] = [];
	for (let pi = 0; pi < pageNums.length; pi++) {
		const pageAnchors = byPage.get(pageNums[pi]) as Anchor[];
		let head = 0;
		const prev =
			pi > 0 && pageNums[pi] === pageNums[pi - 1] + 1 ? byPage.get(pageNums[pi - 1]) : undefined;
		if (prev !== undefined) {
			// Largest run K where prev's last K rows equal this page's first K rows.
			const maxK = Math.min(prev.length, pageAnchors.length);
			let runLen = 0;
			for (let k = 1; k <= maxK; k++) {
				let ok = true;
				for (let j = 0; j < k; j++) {
					if (!sameRecord(prev[prev.length - k + j], pageAnchors[j])) {
						ok = false;
						break;
					}
				}
				if (ok) runLen = k;
			}
			for (let j = 0; j < runLen; j++) foldInto(prev[prev.length - runLen + j], pageAnchors[j]);
			head = runLen;
		}
		for (let j = head; j < pageAnchors.length; j++) merged.push(pageAnchors[j]);
	}
	anchors.length = 0;
	anchors.push(...merged);

	// Resolve signs: balance delta first, column position as fallback.
	const transactions: ParsedTransaction[] = [];
	let previousBalance = meta.openingBalance ?? null;
	const midpoint = (columns.debitRight + columns.creditRight) / 2;

	const sortText = (parts: (Fragment & { page?: number })[]) =>
		[...parts]
			.sort((a, b) => readingY(b.page ?? 0, b.y) - readingY(a.page ?? 0, a.y) || a.x - b.x)
			.map((p) => p.text)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();

	for (const anchor of anchors) {
		const dateText = sortText(anchor.dateParts);
		const altText = anchor.altDateParts === undefined ? '' : sortText(anchor.altDateParts);
		const date =
			parseStatementDate(dateText) ??
			parseStatementDate(altText) ??
			parseStatementDate(`${dateText} ${altText}`.trim()) ??
			parseStatementDate(`${altText} ${dateText}`.trim());
		if (date === null) {
			warnings.push(`Skipped a row with unrecognized date "${dateText}".`);
			continue;
		}
		if (anchor.amountAbs === null) {
			warnings.push(`Skipped a row dated ${dateText}: no debit/credit amount found.`);
			continue;
		}

		const abs = anchor.amountAbs;
		let amount: number;
		if (previousBalance !== null && cents(previousBalance - abs) === cents(anchor.balance)) {
			amount = -abs;
		} else if (previousBalance !== null && cents(previousBalance + abs) === cents(anchor.balance)) {
			amount = abs;
		} else if (anchor.amountRight !== null) {
			amount = anchor.amountRight <= midpoint ? -abs : abs;
		} else {
			amount = -abs;
		}
		previousBalance = anchor.balance;

		const reference = sortText(anchor.refParts);
		transactions.push({
			date,
			description: sortText(anchor.remarkParts),
			amount,
			balance: anchor.balance,
			reference: reference === '' ? undefined : reference
		});
	}

	return { rows: transactions, meta, warnings };
}

export const gtbankParser: PdfStatementParser = {
	name: 'gtbank',
	// Recognises any statement with a Debit(s)/Credit(s)/Balance table. Also the
	// dispatcher's fallback, so this parser runs even when detection is uncertain.
	detect: (pages) => {
		const rows = clusterRows(pages[0] ?? []);
		return findColumns(rows) !== null;
	},
	parse: parseGtbank
};
