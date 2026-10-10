import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { normalizeRotation, normalizeRulings, type Item, type Ruling } from './parsers/pdf-shared.js';
import { StatementParseError } from './errors.js';

type PDFPageProxy = Awaited<ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>['getPage']>>;
const DRAW_MOVE = 0;
const DRAW_LINE = 1;
const DRAW_CURVE = 2;
const DRAW_QUAD = 3;
const DRAW_CLOSE = 4;

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Apply a PDF matrix (row-vector convention) to a point. */
function apply(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Matrix that applies `a` first, then `b` (so a point maps a → b). */
function compose(a: Matrix, b: Matrix): Matrix {
	return [
		b[0] * a[0] + b[2] * a[1],
		b[1] * a[0] + b[3] * a[1],
		b[0] * a[2] + b[2] * a[3],
		b[1] * a[2] + b[3] * a[3],
		b[0] * a[4] + b[2] * a[5] + b[4],
		b[1] * a[4] + b[3] * a[5] + b[5]
	];
}

/**
 * Recover the page's straight vector ruling lines (table borders) from its
 * drawing operators, in the same PDF-point, y-up frame as the text items so the
 * lattice extractor can pair them. We replay the operator list tracking only the
 * CTM (save/restore/transform) and the constructed paths, emitting one
 * {@link Ruling} per straight segment; curves and the matrix bookkeeping for
 * fills/strokes are irrelevant to where the lines sit. Best-effort: any failure
 * yields no rulings, leaving the text strategies untouched.
 */
async function extractRulings(page: PDFPageProxy): Promise<Ruling[]> {
  const { OPS } = await getResolvedPDFJS();
	let opList;
	try {
		opList = await page.getOperatorList();
	} catch {
		return [];
	}
	const rulings: Ruling[] = [];
	let ctm: Matrix = IDENTITY;
	const stack: Matrix[] = [];

	const segment = (x1: number, y1: number, x2: number, y2: number) => {
		const [ax, ay] = apply(ctm, x1, y1);
		const [bx, by] = apply(ctm, x2, y2);
		rulings.push({ x1: ax, y1: ay, x2: bx, y2: by });
	};

	for (let i = 0; i < opList.fnArray.length; i++) {
		const fn = opList.fnArray[i];
		const args = opList.argsArray[i];
		if (fn === OPS.save) {
			stack.push(ctm);
		} else if (fn === OPS.restore) {
			ctm = stack.pop() ?? IDENTITY;
		} else if (fn === OPS.transform) {
			ctm = compose(args as unknown as Matrix, ctm);
		} else if (fn === OPS.constructPath) {
			// args = [pathOp, [encodedPathData], minMax]; the encoded data is a flat
			// run of DrawOPS-tagged coordinates.
			const data = (args as unknown[])[1] as ArrayLike<number>[] | undefined;
			const path = Array.isArray(data) ? data[0] : undefined;
			// PDF.js returns typed arrays for encoded paths, not just JS arrays.
			if (!Array.isArray(path) && !ArrayBuffer.isView(path)) continue;
			let cx = 0,
				cy = 0,
				sx = 0,
				sy = 0;
			for (let j = 0; j < path.length; ) {
				switch (path[j++]) {
					case DRAW_MOVE:
						cx = sx = path[j++];
						cy = sy = path[j++];
						break;
					case DRAW_LINE: {
						const x = path[j++];
						const y = path[j++];
						segment(cx, cy, x, y);
						cx = x;
						cy = y;
						break;
					}
					case DRAW_CURVE:
						cx = path[j + 4];
						cy = path[j + 5];
						j += 6;
						break;
					case DRAW_QUAD:
						cx = path[j + 2];
						cy = path[j + 3];
						j += 4;
						break;
					case DRAW_CLOSE:
						segment(cx, cy, sx, sy);
						cx = sx;
						cy = sy;
						break;
					default:
						j = path.length; // unknown op: stop decoding this path
				}
			}
		}
	}
	return rulings;
}

/** Extract positioned text and table borders, releasing the PDF in all cases. */
export async function extractPdf(data: Uint8Array, password?: string): Promise<{ pages: Item[][]; rulings: Ruling[][] }> {
  if (data.length === 0) throw new StatementParseError('invalid_pdf', 'The PDF is empty.');
  const doc = await getDocumentProxy(data, { password, verbosity: 0 });
  try {
    const pages: Item[][] = [];
    const rulings: Ruling[][] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      try {
        const content = await page.getTextContent();
        const items: Item[] = [];
        for (const raw of content.items) {
          if (!('str' in raw) || raw.str.trim() === '') continue;
          items.push({ text: raw.str, x: raw.transform[4], y: raw.transform[5], width: raw.width });
        }
        pages.push(normalizeRotation(items, page.rotate));
        rulings.push(normalizeRulings(await extractRulings(page), page.rotate));
      } finally {
        page.cleanup();
      }
    }
    return { pages, rulings };
  } finally {
    await doc.loadingTask.destroy();
  }
}
