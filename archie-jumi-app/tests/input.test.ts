import { describe, expect, it } from 'vitest';
import { missedRelease } from '../src/core/input';

describe('lost-pointerup guard', () => {
  it('cancels a capture only for a move with no button pressed', () => {
    expect(missedRelease(true, 0)).toBe(true);
    expect(missedRelease(true, 1)).toBe(false);
    expect(missedRelease(true, 2)).toBe(false);
    expect(missedRelease(true, 3)).toBe(false);
    expect(missedRelease(true, 4)).toBe(false);
  });

  it('never fires without a captured pointer', () => {
    for (const buttons of [0, 1, 2, 3]) expect(missedRelease(false, buttons)).toBe(false);
  });
});
