/** Settings-window feedback for Copy diagnostics. Pure, so Vitest checks it without a DOM. */

/**
 * The error banner once a copy succeeds: the error an earlier failed copy put up (such as "The
 * clipboard is busy") is cleared, but an unrelated one, such as a failed save, stays until it is
 * resolved or dismissed. `copyFailure` is the message the last failed copy showed ('' for none).
 */
export function errorAfterCopySuccess(current: string, copyFailure: string): string {
  return copyFailure !== '' && current === copyFailure ? '' : current;
}
