# statement-kit

Parse Nigerian bank statement PDFs into account information and transactions. Export the transactions as CSV, TSV, custom delimited text, or JSON.

Parsing runs locally using [unpdf](https://github.com/unjs/unpdf) and PDF.js; statement files are not uploaded to a service.

## Installation

Requires **Node.js 22 or newer**, or **Bun**. This package supports ES modules and CommonJS and is intended for server-side JavaScript. TypeScript declarations are included for both formats.

Once the package is published to npm:

```sh
npm install statement-kit
# or
bun add statement-kit
```

To use this checkout locally:

```sh
bun install
bun run build
```

You can then import from `./dist/index.js`, require `./dist/index.cjs`, or install the built checkout into another project with `npm install /path/to/statement-kit`.

## Quick start

```ts
import { parse } from "statement-kit";

// Synchronous. Parsing failures are returned; parse does not throw.
const { data, error } = parse("gtbank", "path/to/statement.pdf");

if (error) {
  console.error(error.code, error.message);
  // data is a StatementFailure with status "error", diagnostic info,
  // warnings, and an empty transactions array.
} else {
  // data is a Statement with status "success".
  console.log(data.info);
  console.log(data.transactions);
  console.log(data.warnings);
  console.log(data.toCSV());
}
```

For CommonJS, load the same API with `require`:

```js
const { parse, parseAsync } = require("statement-kit");
```

`ParseResult` is a TypeScript discriminated union. Checking `error` narrows `data` to its corresponding success or failure class. Failure data has no export methods, so it cannot be mistaken for a successfully parsed empty statement.

## Supported banks and institutions

| ID | Institution | Supported PDF layouts |
| --- | --- | --- |
| `gtbank` | Guaranty Trust Bank (GTBank) | Short-form statements and landscape long-form statements, including rotated pages, wrapped remarks/references, and the Originating Branch column. |
| `zenith` | Zenith Bank | Date / Description / Debit / Credit / Value Date / Balance tables, including value dates joined to credit amounts and headers carried across pages. |
| `uba` | United Bank for Africa (UBA) | Trans Date / Value Date / Narration / Debit / Credit / Balance tables, including split headers, summary pages, and wrapped narration. |
| `cowrywise` | Cowrywise | Stash-style Amount / Fee / Type / Balance breakdowns with stacked direction, value, and date rows. Cowrywise is an investment platform; other product layouts are not guaranteed. |

Names are case-insensitive and ignore spaces, hyphens, and punctuation. Aliases include `gtb`, `gt`, `guaranty-trust-bank`, `zenith-bank`, and `united-bank-for-africa`.

```ts
import { supportedBanks } from "statement-kit";

console.log(supportedBanks);
// [{ id: "gtbank", name: "Guaranty Trust Bank (GTBank)" }, ...]
```

Two additional parser modes are available:

- `auto`: use layout detection to select a dedicated parser, then try generic table detection when none matches. Detection uses branding and table shape, so check the returned `data.info.bank`.
- `generic`: explicitly use generic table detection, using drawn borders when available and text alignment otherwise. Generic results include a warning and need verification. This is best-effort support for other layouts, not a claim that every Nigerian bank is supported.

An explicit institution ID uses its dedicated parser. It returns `unsupported_layout` when that parser cannot recognize the document, rather than silently trying another bank's algorithm.

## Asynchronous parsing

```ts
import { parseAsync } from "statement-kit";

const { data, error } = await parseAsync("uba", "path/to/statement.pdf");

if (!error) {
  console.log(data.info.accountNumber);
  console.log(data.toTSV());
}
```

`parse()` preserves the synchronous API and blocks the calling thread. It runs PDF parsing in a child process using the current Node.js or Bun executable. The default child-process timeout is 120 seconds, with a 64 MiB output limit. Use `parseAsync()` for request handlers or environments that cannot start child processes. It reads files asynchronously and parses in the current process; PDF processing still uses CPU on that process's event loop.

## Inputs and passwords

Both functions accept a local file path, a `file:` URL, a `Buffer`, a `Uint8Array`, or an `ArrayBuffer`. Paths are relative to the current working directory. Caller-owned binary input is copied so PDF processing does not detach or modify it. Remote URLs are not accepted.

```ts
import { readFile } from "node:fs/promises";
import { parse, parseAsync } from "statement-kit";

const bytes = await readFile("statement.pdf");
const fromBytes = await parseAsync("zenith", bytes);

const protectedStatement = parse("gtbank", "protected.pdf", {
  password: "your-statement-password",
  timeoutMs: 30_000,
});
```

The optional third argument accepts:

| Option | Meaning |
| --- | --- |
| `password?: string` | Password for an encrypted PDF. |
| `timeoutMs?: number` | Positive integer timeout in milliseconds for **synchronous `parse()` only**. Defaults to `120000`; it does not impose a timeout on `parseAsync()`. |

## Statement data

A successful `data` value is an instance of the exported `Statement` class:

```ts
{
  info: {
    bank: "gtbank",
    bankName: "Guaranty Trust Bank (GTBank)",
    accountNumber: "0123456789",
    currency: "NGN",
    openingBalance: 100000,
    // accountName and period are present when readable.
  },
  transactions: [
    {
      date: 1769904000000, // 2026-02-01 at UTC midnight, in milliseconds
      description: "POS PURCHASE",
      amount: -5000,
      balance: 95000,
      reference: "REF001",
    },
  ],
  warnings: [],
}
```

- `amount` is signed: negative for debits/outflows, positive for credits/inflows. Amounts and balances are in major currency units, such as naira, not kobo.
- `date` is a UTC timestamp in milliseconds. Numeric dates follow Nigeria's day-first convention, with month-first fallback when day-first is invalid.
- `balance` and `reference` are optional. Account metadata is optional except for `bank` and `bankName`; masked account numbers remain masked. `period` retains the printed text.
- For Cowrywise, `amount` excludes the separately printed fee. A nonzero fee is included in the description, and the parser accounts for outflow fees when checking balances.
- Transactions remain in statement order. Duplicate-looking rows are retained. Currency is read from the statement when available; it is not assumed to be NGN.
- Metadata, transaction records, transaction arrays, and warnings are read-only snapshots. `toJSON()` returns independent mutable copies.

## Exporting

```ts
import { writeFileSync } from "node:fs";
import { parse } from "statement-kit";

const { data, error } = parse("gtbank", "statement.pdf");

if (!error) {
  writeFileSync("transactions.csv", data.toCSV());
  writeFileSync("transactions.tsv", data.toTSV());
  writeFileSync("transactions.txt", data.toDelimited(";"));
  writeFileSync("statement.json", JSON.stringify(data.toJSON(), null, 2));
}
```

CSV, TSV, and delimited exports have these columns:

```text
date,description,amount,balance,reference
```

Dates are exported as `YYYY-MM-DD`, amounts as two decimal places, and missing optional values as empty cells. Fields containing the delimiter, quotes, or newlines are quoted; internal quotes are doubled. CSV uses CRLF line endings by default, and TSV/custom delimiters use LF.

Each text export accepts these options:

```ts
data.toCSV({
  header: false,         // default: true
  newline: "\n",        // "\n" or "\r\n"
  escapeFormulas: false, // default: true
});
```

By default, descriptions and references that begin with formula-like characters (`=`, `+`, `-`, or `@`, including after leading whitespace) receive an apostrophe prefix. Numeric debits retain their negative sign. Set `escapeFormulas: false` when exact text is needed for another parser.

`toJSON()` returns an object containing `info`, `transactions`, and `warnings`; `JSON.stringify(data)` uses the same snapshot. Export methods can throw for invalid export arguments, such as a delimiter longer than one character. The no-throw contract applies to `parse()` and `parseAsync()`.

## Errors and warnings

On failure, `error` is a `StatementParseError`, and `data` is a `StatementFailure`. `data.error` is the same error object. Both parsing functions return these failures instead of throwing or rejecting.

| `error.code` | Meaning |
| --- | --- |
| `unsupported_bank` | The institution or parser mode is not registered. |
| `invalid_input` | The source, bank argument, or options are invalid. |
| `file_not_found` | The local file does not exist. |
| `file_read_failed` | The path is unreadable or is a directory. |
| `invalid_pdf` | The PDF is empty, malformed, or unreadable. |
| `password_required` | The PDF needs a password. |
| `password_incorrect` | The supplied PDF password is incorrect. |
| `unsupported_layout` | The selected parser cannot recognize this statement layout. |
| `no_transactions` | A recognizable table contains no readable transactions. |
| `timeout` | Synchronous PDF processing exceeded `timeoutMs`. |
| `parse_failed` | Another loading, parsing, or child-process failure occurred. |

Failure data contains any metadata and warnings available at the point of failure, and an empty transaction array. Errors during file loading may have no metadata.

Warnings do not necessarily make parsing fail. They can report skipped rows, running balances that do not reconcile, or generic parsing. Review warnings and compare extracted transactions against the original statement, especially before using the result for accounting.

## Limitations

The parsers require selectable PDF text. Scanned/image-only statements need OCR first. CSV, Excel, and images are not input formats for this library. Bank layouts can change; support refers to the layouts listed above, not every product or historical statement issued by an institution. Empty statements return `no_transactions` rather than a successful result with no rows.

No account metadata is invented when the statement does not expose it. Parsing does not authenticate a statement or validate its provenance. The library performs no network requests; applications loading untrusted or very large PDFs should set appropriate process and resource limits.

## Development

```sh
bun install
bun run typecheck
bun test # after building, or use the combined command below
bun run test
bun run build
npm pack --dry-run
```

`bun run build` uses tsup to generate ESM (`dist/index.js`), CommonJS (`dist/index.cjs`), their TypeScript declarations, and the private PDF workers. `bun run test` builds the package and runs the tests. Tests cover supported bank layouts, generic text/border extraction, real synthetic PDF loading, rotated and multipage documents, password failures, the non-throwing API, exports, and Node.js compatibility through both `import` and `require`.

Five randomized PDF replicas are included under [`tests/fixtures/statements`](./tests/fixtures/statements/README.md), covering 128 pages and 1,740 transactions. They preserve the reference layouts and page counts while replacing customer data with fictional values. Their independent JSON expectations verify every parsed field through both `parse()` and `parseAsync()`. Tests use the included files directly and require none of the original documents. See the fixture README for seeds, hashes, and regeneration with `bun run fixtures:generate`.

Bank algorithms live in `src/parsers`. To add an institution, implement a positioned-text parser, register its ID and aliases in `src/banks.ts`, add it to `BankName` and automatic detection, then add layout/PDF tests and update the supported-bank list.

## License

[MIT](./LICENSE).
