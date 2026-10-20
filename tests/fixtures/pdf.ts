// Synthetic PDFs only: no customer statements or personal information.
import { createHash } from 'node:crypto';
import type { Item } from '../../src/parsers/pdf-shared.js';

export const item = (text: string, x: number, y: number): Item => ({ text, x, y, width: text.length * 3.6 });

export const layouts = {
  gtbank: [[
    item('Guaranty Trust Bank', 50, 790), item('Account Number: 0123456789', 50, 780),
    item('Currency: NGN', 50, 770), item('Opening Balance: 100,000.00', 50, 760),
    item('Trans Date', 50, 700), item('Reference', 120, 700), item('Value Date', 200, 700),
    item('Debit', 280, 700), item('Credit', 340, 700), item('Balance', 400, 700), item('Remarks', 470, 700),
    item('01/Feb/26', 50, 680), item('REF001', 120, 680), item('5,000.00', 280, 680),
    item('95,000.00', 400, 680), item('POS PURCHASE', 470, 680),
    item('02/Feb/26', 50, 650), item('REF002', 120, 650), item('10,000.00', 340, 650),
    item('105,000.00', 400, 650), item('SALARY', 470, 650),
  ]],
  zenith: [[
    item('Zenith Bank', 50, 790), item('Account No: 0123456789', 50, 780),
    item('ACCOUNT NAME: TEST CUSTOMER', 50, 770), item('Currency: NGN', 50, 760),
    item('Date', 50, 700), item('Description', 100, 700), item('Debit', 300, 700),
    item('Credit', 380, 700), item('Balance', 460, 700),
    item('Opening Balance', 100, 690), item('100,000.00', 460, 690),
    item('01/Feb/26', 50, 670), item('POS PURCHASE', 100, 670), item('5,000.00', 300, 670),
    item('0.00 01/02/2026', 380, 670), item('95,000.00', 460, 670),
    item('WRAPPED DESCRIPTION', 100, 660),
  ], [
    // No repeated header: column positions carry over to the next page.
    item('02/Feb/26', 50, 750), item('SALARY', 100, 750), item('0.00', 300, 750),
    item('10,000.00 02/02/2026', 380, 750), item('105,000.00', 460, 750),
  ]],
  uba: [[
    item('United Bank for Africa', 50, 790), item('Hello TEST CUSTOMER!', 50, 780),
    item('214xxxxx25', 50, 770), item('Currency: NGN', 50, 760),
  ], [
    item('Trans', 50, 706), item('Value', 110, 706), item('Chq', 320, 706),
    item('Narration', 170, 700), item('Debit', 340, 700), item('Credit', 400, 700), item('Balance', 460, 700),
    item('Date', 50, 694), item('Date', 110, 694), item('No', 320, 694),
    item('Opening Balance', 170, 680), item('100,000.00', 460, 680),
    item('01-Feb-2026', 50, 660), item('POS PURCHASE', 170, 660), item('5,000.00', 340, 660), item('95,000.00', 460, 660),
    item('02-Feb-2026', 50, 630), item('SALARY', 170, 630), item('10,000.00', 400, 630), item('105,000.00', 460, 630),
  ]],
  cowrywise: [[
    item('Cowrywise', 50, 790), item('Account Holder', 50, 780), item('TEST CUSTOMER', 50, 770),
    item('Naira Stash Breakdown', 50, 760), item('Feb 01, 2026 - Feb 28, 2026', 50, 750),
    item('Amount (NGN)', 150, 700), item('Fee (NGN)', 250, 700), item('Type', 350, 700), item('Balance (NGN)', 450, 700),
    item('Inflow', 50, 680), item('10,000.00', 150, 670), item('0.00', 250, 670), item('Transfer', 350, 670), item('10,000.00', 450, 670),
    item('Feb 01, 2026', 50, 660),
    item('Outflow', 50, 640), item('-2,000.00', 150, 630), item('25.00', 250, 630), item('Withdrawal', 350, 630), item('7,975.00', 450, 630),
    item('Feb 02, 2026', 50, 620),
  ]],
  generic: [[
    item('Date', 50, 700), item('Description', 170, 700), item('Amount', 340, 700), item('Balance', 460, 700),
    item('01-Feb-2026', 50, 680), item('TRANSFER', 170, 680), item('-5,000.00', 340, 680), item('95,000.00', 460, 680),
    item('02-Feb-2026', 50, 650), item('SALARY', 170, 650), item('10,000.00', 340, 650), item('105,000.00', 460, 650),
  ]],
} satisfies Record<string, Item[][]>;

const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (value: Buffer) => createHash('md5').update(value).digest();
const padded = (password: string) => Buffer.concat([Buffer.from(password, 'latin1'), padding]).subarray(0, 32);

function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  return Buffer.from(data.map((value) => {
    i = (i + 1) % 256;
    j = (j + state[i]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
    return value ^ state[(state[i] + state[j]) % 256];
  }));
}

/** Minimal, valid PDF with real xref offsets, optional rotation, borders and R2 encryption. */
export type FixtureText = Item & { fontSize?: number };

export type PdfFixtureOptions = {
  rotate?: boolean;
  password?: string;
  borders?: boolean;
  pageSize?: [number, number];
  /** Vector furniture (table borders and backgrounds), not source PDF content. */
  pageCommands?: string[][];
};

export function makePdf(pages: FixtureText[][], options: PdfFixtureOptions = {}): Buffer {
  const objects: Buffer[] = [];
  // A tiny vector font keeps the naira symbol visible and text-extractable
  // without copying fonts or any objects from a customer's PDF.
  const naira = pages.some((page) => page.some((item) => item.text.includes('\u20a6')));
  const nairaFontId = 4 + pages.length * 2;
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  let key: Buffer | undefined;
  let encryption = '';
  const add = (value: string | Buffer) => objects.push(typeof value === 'string' ? Buffer.from(value, 'latin1') : value);
  if (options.password !== undefined) {
    const owner = rc4(md5(padded('owner-secret')).subarray(0, 5), padded(options.password));
    const permissions = Buffer.alloc(4);
    permissions.writeInt32LE(-4);
    key = md5(Buffer.concat([padded(options.password), owner, permissions, id])).subarray(0, 5);
    const user = rc4(key, padding);
    encryption = `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`;
  }
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  for (const [pageIndex, page] of pages.entries()) {
    const contentId = objects.length + 2;
    const [pageWidth, pageHeight] = options.pageSize ?? [800, 900];
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ${options.rotate ? '/Rotate 90' : ''} /Resources << /Font << /F1 3 0 R${naira ? ` /F2 ${nairaFontId} 0 R` : ''} >> >> /Contents ${contentId} 0 R >>`);
    let content = page.map((item) => {
      const escaped = item.text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      const matrix = options.rotate ? `0 1 -1 0 ${(options.pageSize?.[0] ?? 900) - item.y} ${item.x}` : `1 0 0 1 ${item.x} ${item.y}`;
      const size = item.fontSize ?? 6;
      const runs = escaped.split('\u20a6').map((part) => `(${part}) Tj`).join(` /F2 ${size} Tf (\\200) Tj /F1 ${size} Tf `);
      return `BT /F1 ${size} Tf ${matrix} Tm ${runs} ET`;
    }).join('\n');
    // Furniture is expressed in upright coordinates, like the text above.
    const furniture = (options.pageCommands?.[pageIndex] ?? []).join('\n');
    const furnitureMatrix = options.rotate ? `0 1 -1 0 ${pageWidth} 0 cm` : '';
    content = `q ${furnitureMatrix}\n${furniture}\nQ\n${content}`;
    if (options.borders) {
      content += '\n' + [710, 690, 670, 640].map((y) => `45 ${y} m 580 ${y} l S`).join('\n');
      content += '\n' + [45, 160, 330, 450, 580].map((x) => `${x} 640 m ${x} 710 l S`).join('\n');
    }
    let stream: Buffer = Buffer.from(content, 'latin1');
    if (key) {
      const objectId = Buffer.from([contentId & 255, (contentId >> 8) & 255, (contentId >> 16) & 255, 0, 0]);
      stream = rc4(md5(Buffer.concat([key, objectId])).subarray(0, 10), stream);
    }
    add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  }
  if (naira) {
    if (key) throw new Error('Naira fixture font does not support encrypted test PDFs.');
    add(`<< /Type /Font /Subtype /Type3 /FontBBox [0 -100 600 800] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /naira ${nairaFontId + 1} 0 R >> /Encoding << /Type /Encoding /Differences [128 /naira] >> /FirstChar 128 /LastChar 128 /Widths [600] /Resources << >> /ToUnicode ${nairaFontId + 2} 0 R >>`);
    const glyph = '600 0 0 -100 600 800 d1 45 w 100 0 m 100 700 l 500 0 l 500 700 l S 30 290 m 570 290 l 30 410 m 570 410 l S';
    add(`<< /Length ${glyph.length} >>\nstream\n${glyph}\nendstream`);
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /NairaUnicode def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <80> <20A6> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
    add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  }
  if (key) add(encryption);
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    chunks.push(Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]));
  }
  const xref = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${key ? `/Encrypt ${objects.length} 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
