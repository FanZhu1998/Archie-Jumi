import { describe, expect, it } from 'vitest';
import { BOX_MAX_PX, BOX_MAX_WASTE, BOX_STEP_PX, fitDeviceBox, unionRects, type DeviceBox } from '../src/rendering/layer-box';

/** The scene rect a box covers at `dpr`. */
const covered = (box: DeviceBox, dpr: number) => ({ x: box.left / dpr, y: box.top / dpr, width: box.width / dpr, height: box.height / dpr });
const covers = (outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x - 1e-9 && inner.y >= outer.y - 1e-9 && inner.x + inner.width <= outer.x + outer.width + 1e-9 && inner.y + inner.height <= outer.y + outer.height + 1e-9;

describe('layer device boxes', () => {
  it('places layers on whole device pixels and covers the content at any scale factor', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) for (const rect of [{ x: 10.3, y: -4.9, width: 200.2, height: 150.7 }, { x: 0, y: 0, width: 1, height: 1 }, { x: 999.99, y: 333.33, width: 0.01, height: 64 }]) {
      const box = fitDeviceBox(rect, dpr, null)!;
      for (const value of [box.left, box.top, box.width, box.height]) expect(Number.isInteger(value)).toBe(true);
      expect(box.width % BOX_STEP_PX).toBe(0);
      expect(box.height % BOX_STEP_PX).toBe(0);
      expect(covers(covered(box, dpr), rect)).toBe(true);
    }
  });

  it('keeps the backing size while moving content still fits, so a walking kitten never reallocates its canvas', () => {
    const dpr = 1.25;
    let box = fitDeviceBox({ x: 100, y: 200, width: 210.8, height: 266.1 }, dpr, null)!;
    const size = { width: box.width, height: box.height };
    for (let step = 0; step < 400; step++) {
      const rect = { x: 100 + step * 1.83, y: 200 + Math.sin(step) * 3, width: 210.8, height: 266.1 };
      box = fitDeviceBox(rect, dpr, box)!;
      expect({ width: box.width, height: box.height }).toEqual(size);
      expect(covers(covered(box, dpr), rect)).toBe(true);
    }
  });

  it('grows when the content outgrows the box and shrinks when the kept one would waste too much', () => {
    const small = fitDeviceBox({ x: 0, y: 0, width: 40, height: 40 }, 1, null)!;
    expect([small.width, small.height]).toEqual([48, 48]);
    // Grow-only per side: the width grows to fit, the height that still fits keeps its 48 px.
    const grown = fitDeviceBox({ x: 0, y: 0, width: 60, height: 30 }, 1, small)!;
    expect([grown.width, grown.height]).toEqual([64, 48]);
    const big = fitDeviceBox({ x: 0, y: 0, width: 400, height: 400 }, 1, null)!;
    const kept = fitDeviceBox({ x: 5, y: 5, width: 300, height: 300 }, 1, big)!;
    expect([kept.width, kept.height]).toEqual([big.width, big.height]);
    // 400 × 400 kept for 20 × 20 content would waste far more than BOX_MAX_WASTE times its pixels.
    expect(big.width * big.height).toBeGreaterThan(BOX_MAX_WASTE * 20 * 20);
    const tiny = fitDeviceBox({ x: 5, y: 5, width: 20, height: 20 }, 1, big)!;
    expect([tiny.width, tiny.height]).toEqual([32, 32]);
  });

  it('refuses unusable input and caps runaway sizes', () => {
    expect(fitDeviceBox({ x: NaN, y: 0, width: 10, height: 10 }, 1, null)).toBeNull();
    expect(fitDeviceBox({ x: 0, y: 0, width: Infinity, height: 10 }, 1, null)).toBeNull();
    expect(fitDeviceBox({ x: 0, y: 0, width: 10, height: 10 }, 0, null)).toBeNull();
    expect(fitDeviceBox({ x: 0, y: 0, width: 10, height: 10 }, NaN, null)).toBeNull();
    const huge = fitDeviceBox({ x: 0, y: 0, width: 1e6, height: 1e6 }, 2, null)!;
    expect([huge.width, huge.height]).toEqual([BOX_MAX_PX, BOX_MAX_PX]);
    const negative = fitDeviceBox({ x: 3, y: 3, width: -5, height: -5 }, 1, null)!;
    expect(negative.width).toBeGreaterThan(0);
  });

  it('unites finite rects and ignores missing or non-finite ones', () => {
    expect(unionRects()).toBeNull();
    expect(unionRects(null, undefined, { x: NaN, y: 0, width: 1, height: 1 })).toBeNull();
    expect(unionRects({ x: 0, y: 0, width: 10, height: 10 }, null, { x: -5, y: 4, width: 2, height: 20 })).toEqual({ x: -5, y: 0, width: 15, height: 24 });
  });
});
