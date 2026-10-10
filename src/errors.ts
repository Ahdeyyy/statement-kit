export type ParseErrorCode =
  | 'unsupported_bank'
  | 'invalid_input'
  | 'file_not_found'
  | 'file_read_failed'
  | 'invalid_pdf'
  | 'password_required'
  | 'password_incorrect'
  | 'unsupported_layout'
  | 'no_transactions'
  | 'timeout'
  | 'parse_failed';

export class StatementParseError extends Error {
  override readonly name = 'StatementParseError';

  constructor(public readonly code: ParseErrorCode, message: string) {
    super(message);
  }

  toJSON(): { name: string; code: ParseErrorCode; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

/** Never exposes PDF contents or passwords in diagnostic messages. */
export function normalizeError(error: unknown): StatementParseError {
  if (error instanceof StatementParseError) return error;
  if (error !== null && typeof error === 'object') {
    const e = error as { name?: string; code?: string | number };
    if (e.name === 'PasswordException') {
      return e.code === 2
        ? new StatementParseError('password_incorrect', 'The PDF password is incorrect.')
        : new StatementParseError('password_required', 'This PDF requires a password.');
    }
    if (e.code === 'ENOENT') {
      return new StatementParseError('file_not_found', 'The statement file does not exist.');
    }
    if (['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(String(e.code))) {
      return new StatementParseError('file_read_failed', 'The statement file could not be read.');
    }
    if (e.name === 'InvalidPDFException' || e.name === 'MissingPDFException') {
      return new StatementParseError('invalid_pdf', 'The file is not a readable PDF.');
    }
    if (e.code === 'ETIMEDOUT') {
      return new StatementParseError('timeout', 'PDF parsing exceeded the configured timeout.');
    }
  }
  return new StatementParseError('parse_failed', 'The statement could not be parsed.');
}
