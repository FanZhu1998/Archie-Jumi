import { describe, expect, it } from 'vitest';
import { CURIOUS_RADIUS, LEAP_HEIGHT } from '../src/core/engine';
import { CARRY_SWING_FULL_SPEED, LAND_SQUASH_MS, TURN_MS, framePoint, frameUV, placementBounds, poseFor, restPlacement, squeezed, type PoseInput } from '../src/core/motion';
import { MAX_ATTENTION_RECTS, MAX_INTEREST_RECTS, validInterest } from '../src/shared/ipc';
import { ACTIONS, type PetState, type Rect } from '../src/shared/types';
import {
  ATTENTION_HALF_SIZE, INTEREST_MARGIN, TOY_RADIUS, attentionRect, buildAttentionRects, buildInterest, buildInterestRects, inflateRect, interestKey, rectsKey, roundOutward,
} from '../src/rendering/interest';
import { unionRects } from '../src/rendering/layer-box';
import { spriteHitBounds, spritePlacement, spriteRect } from '../src/rendering/sprite';

const inside = (rects: readonly Rect[], x: number, y: number) => rects.some(r => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
const petState = (patch: Partial<PetState> = {}): PetState => ({
  id: 'archie', x: 700, y: 420, action: 'idle', actionTime: 0, facing: 'right', forcedSleep: false, visible: true,
  size: 128, target: null, speed: 0, leap: null, held: false, ...patch,
});

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

  it('builds attention squares of half-size 1.6 × size around attentive kittens, as they are, apart from the hover rects', () => {
    expect(ATTENTION_HALF_SIZE).toBe(CURIOUS_RADIUS);
    const big = attentionRect({ x: 500, y: 300, size: 128 });
    for (const [value, expected] of [[big.x, 500 - 204.8], [big.y, 300 - 204.8], [big.width, 409.6], [big.height, 409.6]]) expect(value).toBeCloseTo(expected, 9);
    const square = attentionRect({ x: 500, y: 300, size: 100 });
    expect(buildAttentionRects([square])).toEqual([{ x: 340, y: 140, width: 320, height: 320 }]);
    expect(buildAttentionRects([{ x: NaN, y: 0, width: 1, height: 1 }])).toEqual([]);
    // The square covers every cursor position the engine's curiosity looks at (within 1.6 × size of the centre).
    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      expect(inside([square], 500 + Math.cos(angle) * 160, 300 + Math.sin(angle) * 160)).toBe(true);
    }
    // Squares never join the hover rects that feed main's hover guard: a stale hover is cleared as soon
    // as main's cursor leaves the sprite + 24 DIP, even inside a square.
    const sprite = { x: 440, y: 230, width: 120, height: 140 };
    const region = buildInterest([sprite], { x: 700, y: 300 }, [square]);
    expect(region.rects).toEqual(buildInterestRects([sprite], { x: 700, y: 300 }));
    expect(region.attention).toEqual(buildAttentionRects([square]));
    expect(region.rects).toHaveLength(2);
    expect(inside(region.rects, 500 + 120, 300)).toBe(false);
    expect(inside(region.attention, 500 + 120, 300)).toBe(true);
    // Clipped to the scene, a big kitten's square in a small scene still passes main's validation.
    const scene = { width: 300, height: 260 };
    const clipped = attentionRect({ x: 150, y: 130, size: 192 }, scene);
    expect(clipped).toEqual({ x: 0, y: 0, width: 300, height: 260 });
    expect(validInterest({ generation: 1, rects: [], attention: buildAttentionRects([clipped]) }, scene)).not.toBeNull();
    expect(validInterest({ generation: 1, rects: [], attention: buildAttentionRects([attentionRect({ x: 150, y: 130, size: 192 })]) }, scene)).toBeNull();
    expect(attentionRect({ x: 40, y: 200, size: 100 }, { width: 1000, height: 800 })).toEqual({ x: 0, y: 40, width: 200, height: 320 });
    // The largest scene stays within the IPC bound: two sprites and the toy, plus two attention squares.
    const most = buildInterest([{ x: 0, y: 0, width: 10, height: 10 }, { x: 50, y: 0, width: 10, height: 10 }], { x: 9, y: 9 }, [square, attentionRect({ x: 1, y: 1, size: 192 })]);
    expect(most.rects).toHaveLength(3);
    expect(most.attention).toHaveLength(2);
    expect(most.rects.length).toBeLessThanOrEqual(MAX_INTEREST_RECTS);
    expect(most.attention.length).toBeLessThanOrEqual(MAX_ATTENTION_RECTS);
    expect(validInterest({ generation: 1, ...most }, { width: 1000, height: 800 })).toEqual({ generation: 1, ...most });
  });

  it('covers every pixel hit testing can return, for every pose the motion layer produces', () => {
    const geometry = { frameWidth: 512, frameHeight: 512, anchor: { x: 256, y: 464 } };
    const inputs: PoseInput[] = [];
    const base = (pet: Partial<PetState>, patch: Partial<Omit<PoseInput, 'pet'>> = {}): PoseInput => ({
      pet: petState(pet), time: 30, reducedMotion: false, velocityX: 0, facingChange: null, actionChange: null, breathPhase: 0, ...patch,
    });
    for (const action of ACTIONS) for (let t = 0; t < 2; t += 0.1) inputs.push(base({ action, actionTime: t, speed: 70 }));
    for (const velocityX of [-CARRY_SWING_FULL_SPEED, CARRY_SWING_FULL_SPEED]) inputs.push(base({ action: 'carried' }, { velocityX }));
    for (let progress = 0; progress <= 1; progress += 0.1) inputs.push(base({ action: 'pounce', leap: { fromX: 680, fromY: 420, toX: 720, toY: 420, progress, height: LEAP_HEIGHT * 128 } }));
    for (let ms = 0; ms < TURN_MS; ms += 10) for (const action of ['walk', 'groom', 'pet'] as const) {
      inputs.push(base({ action, actionTime: 0.3, speed: 60, facing: 'left' }, { facingChange: { from: 'right', at: 30 - ms / 1000 } }));
    }
    // Landing squashes, with and without a released swing settling.
    for (let ms = 0; ms < LAND_SQUASH_MS; ms += 20) for (const velocityX of [0, -CARRY_SWING_FULL_SPEED, CARRY_SWING_FULL_SPEED]) {
      inputs.push(base({ action: 'land' }, { velocityX, actionChange: { from: 'carried', at: 30 - ms / 1000 } }));
    }
    let restShapes = 0;
    for (const input of inputs) {
      const placement = spritePlacement(input.pet, geometry, poseFor(input));
      // What the overlay publishes for a drawn kitten (spriteHitBounds), with its rest shape while squeezed.
      const rest = squeezed(input) ? restPlacement(placement) : null;
      const bounds = spriteHitBounds({ placement, rest })!;
      expect(bounds).toEqual(unionRects(placementBounds(placement), spriteRect(placement), rest ? placementBounds(rest) : null));
      const rects = buildInterestRects([bounds], null);
      for (const shape of rest ? [placement, rest] : [placement]) for (let u = 0; u <= 1; u += 0.125) for (let v = 0; v <= 1; v += 0.125) {
        const point = framePoint(Math.min(u, 0.999), Math.min(v, 0.999), shape);
        const uv = frameUV(point.x, point.y, shape);
        if (!uv) continue;
        expect(inside(rects, point.x, point.y)).toBe(true);
        // Even a point a margin away from the drawn frame is still inside.
        expect(inside(rects, point.x + INTEREST_MARGIN - 1, point.y - INTEREST_MARGIN + 1)).toBe(true);
      }
      if (rest) restShapes++;
    }
    expect(restShapes).toBeGreaterThan(50);
  });

  it('builds a stable key that changes only with the rounded rects', () => {
    const a = buildInterestRects([{ x: 401.3, y: 202.7, width: 150.4, height: 150.4 }], null);
    const b = buildInterestRects([{ x: 401.5, y: 202.9, width: 150.4, height: 150.4 }], null);
    const c = buildInterestRects([{ x: 409, y: 202.7, width: 150.4, height: 150.4 }], null);
    expect(rectsKey(a)).toBe(rectsKey(b));
    expect(rectsKey(a)).not.toBe(rectsKey(c));
    expect(rectsKey([])).toBe('[]');
    // A region key covers both lists: a square appearing or moving between the lists is a change.
    const square = attentionRect({ x: 500, y: 300, size: 100 });
    expect(interestKey({ rects: a, attention: [] })).not.toBe(interestKey({ rects: a, attention: buildAttentionRects([square]) }));
    expect(interestKey({ rects: [...a, ...buildAttentionRects([square])], attention: [] })).not.toBe(interestKey({ rects: a, attention: buildAttentionRects([square]) }));
    expect(interestKey(buildInterest([], null))).not.toBe('');
  });
});
