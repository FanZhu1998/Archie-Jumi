import { describe, expect, it } from 'vitest';
import { errorAfterCopySuccess } from '../src/ui/copy-feedback';

const busy = 'The clipboard is busy. Please try again.';
const saveFailed = 'That setting could not be saved. Please try again.';

describe('copy diagnostics feedback', () => {
  it('clears the error an earlier failed copy put up once a copy succeeds', () => {
    expect(errorAfterCopySuccess(busy, busy)).toBe('');
  });

  it('keeps an unrelated error, including one shown after a failed copy', () => {
    expect(errorAfterCopySuccess(saveFailed, busy)).toBe(saveFailed);
    expect(errorAfterCopySuccess(saveFailed, '')).toBe(saveFailed);
  });

  it('leaves an empty or dismissed banner empty', () => {
    expect(errorAfterCopySuccess('', busy)).toBe('');
    expect(errorAfterCopySuccess('', '')).toBe('');
  });
});
