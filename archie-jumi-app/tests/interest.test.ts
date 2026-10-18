import { describe, expect, it } from 'vitest';
import { INTEREST_MARGIN, TOY_RADIUS, buildInterestRects, inflateRect, rectsKey, roundOutward } from '../src/rendering/interest';

describe('overlay interest region', () => {
  it('inflates each drawn sprite by 24 DIP and rounds outward to a 4 DIP grid', () => {
    expect(INTEREST_MARGIN).toBe(24);
    expect(inflateRect({ x: 100, y: 50, width: 10, height: 20 }, 24)).toEqual({ x: 76, y: 26, width: 58, height: 68 });
    expect(roundOutward({ x: 1.5, y: -2.2, width: 5, height: 5 })).toEqual({ x: 0, y: -4, width: 8, height: 8 });
    expect(buildInterestRects([{ x: 401.3, y: 202.7, width: 150.4, height: 150.4 }], null)).toEqual([{ x: 376, y: 176, width: 200, height: 204 }]);
  });

  it('adds the toy (radius 18) inflated by the same margin', () => {
    expect(TOY_RADIUS).toBe(18);
    expect(buildInterestRects([], { x: 500, y: 300 })).toEqual([{ x: 456, y: 256, width: 88, height: 88 }]);
  });

  it('contributes nothing for hidden or unpresented kittens and skips non-finite input', () => {
    expect(buildInterestRects([], null)).toEqual([]);
    expect(buildInterestRects([{ x: NaN, y: 0, width: 10, height: 10 }], null)).toEqual([]);
  });

  it('builds a stable key that changes only with the rounded rects', () => {
    const a = buildInterestRects([{ x: 401.3, y: 202.7, width: 150.4, height: 150.4 }], null);
    const b = buildInterestRects([{ x: 401.5, y: 202.9, width: 150.4, height: 150.4 }], null);
    const c = buildInterestRects([{ x: 409, y: 202.7, width: 150.4, height: 150.4 }], null);
    expect(rectsKey(a)).toBe(rectsKey(b));
    expect(rectsKey(a)).not.toBe(rectsKey(c));
    expect(rectsKey([])).toBe('[]');
  });
});
