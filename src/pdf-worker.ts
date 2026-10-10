// Private protocol entry for synchronous parse(); not a package export.
import { readFileSync } from 'node:fs';
import { parseAsync } from './parse.js';

try {
  const request = JSON.parse(readFileSync(0, 'utf8')) as { bank: string; pdf: string; password?: string };
  const result = await parseAsync(request.bank, Buffer.from(request.pdf, 'base64'), { password: request.password });
  process.stdout.write(JSON.stringify(result));
} catch {
  process.exitCode = 1;
}
