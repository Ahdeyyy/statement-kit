# Synthetic statement PDF fixtures

These five PDFs are drawn from scratch with fictional, seeded random data. They
reproduce the parsing layouts of the supplied reference documents, including
their page dimensions, rotation, page counts, and transaction counts. They do
not contain copied PDF pages, embedded source images, original account details,
or original transaction text. Every page is marked as a synthetic test fixture.

The replicas focus on table geometry and parsing behavior; bank logos and other
decorative artwork are not copied. Values retain their field types: dates use
the layout's printed date format, account numbers and references remain strings,
masked accounts remain masked, and money has two decimal places. Currency and
column labels remain NGN and the bank's original structural labels. Random
debits and credits reconcile with independently generated running balances.

| PDF | Pages | Transactions | Behaviors exercised |
| --- | ---: | ---: | --- |
| `gtbank-rotated.pdf` | 98 | 1,097 | Real 90-degree page rotation, first-page-only header, wrapped references, description continuation across a page boundary. |
| `gtbank-short.pdf` | 5 | 55 | Split table headers, dates split into day/month and year, centered variable-height descriptions, repeated boundary transaction. |
| `gtbank-landscape.pdf` | 5 | 58 | Upright landscape, centered headers over left-aligned data, masked account number, wrapped references, Originating Branch column. |
| `uba.pdf` | 7 | 65 | Summary-only first page, masked account, three-row table header, centered narration, ruled tables. |
| `zenith.pdf` | 13 | 465 | Header only on the first page, wrapped descriptions, credit and value date in the same text run, explicit zeros in unused amount columns. |

Each PDF has an accompanying `*.expected.json` containing account information,
every transaction, and expected warnings. The generator derives these values
from its ledger and text fragments; it never imports or calls a statement parser.
Do not replace expectations with parser output just to make a failing test pass.

`manifest.json` records each fixture's seed, geometry, row counts, tested features,
and SHA-256 hashes. `.gitattributes` preserves PDF bytes and JSON line endings.

Run the regression tests from the repository root:

```sh
bun install
bun run test
```

The PDFs and expectations are included in the repository. Running tests does not
require the reference documents, any private file paths, a PDF generator, Python,
a browser, Poppler, or network access after installing dependencies.

To intentionally regenerate the same fixture set:

```sh
bun run fixtures:generate
```

To create a different random dataset, with an explicit reproducible seed:

```sh
bun run fixtures:generate --seed 123456789
bun run test
```

The optional seed must be an unsigned 32-bit integer. Regeneration replaces all
five PDFs, expectations, and manifest together. Review the generated PDFs and
commit the complete fixture set when deliberately updating it. Running the
generator without `--seed` restores the documented default dataset.

The fixture generator is `scripts/generate-pdf-fixtures.ts`. It uses the test
PDF writer in `tests/fixtures/pdf.ts`, which writes fresh PDF objects and vector
table furniture using built-in Helvetica and an explicit WinAnsi encoding.
