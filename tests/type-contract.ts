import type { ParseResult } from '../src/index.js';

// Compile-time regression: destructuring and checking error must narrow data.
export function checkResultContract(result: ParseResult): void {
  const { data, error } = result;
  if (error) {
    const status: 'error' = data.status;
    void status;
    // @ts-expect-error Failure data must not expose successful export methods.
    data.toCSV();
  } else {
    const status: 'success' = data.status;
    void status;
    data.toCSV();
    data.toTSV();
    data.toJSON();
  }
}
