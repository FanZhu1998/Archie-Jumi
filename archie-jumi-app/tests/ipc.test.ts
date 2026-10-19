import { describe, expect, it } from 'vitest';
import { MAX_ATTENTION_RECTS, MAX_INTEREST_RECTS, validHeartbeat, validInputModePayload, validInterest, validSceneState } from '../src/shared/ipc';

const scene = { width: 1280, height: 720 };
const pet = { action: 'sit', facing: 'left', forcedSleep: false };

describe('input-mode payload validation', () => {
  it.each([null, undefined, 1, 'archie', [], {}, { generation: 1, target: 'archie' }, { generation: 1, target: 'Archie', capture: false },
    { generation: 1, target: undefined, capture: false }, { generation: 1, target: '__proto__', capture: false }, { generation: 1, target: null, capture: 'false' },
    { generation: -1, target: null, capture: false }, { generation: 1.5, target: null, capture: false }, { generation: NaN, target: null, capture: false },
    { generation: Infinity, target: null, capture: false }, { generation: '1', target: null, capture: false }])('rejects %j', value => {
    expect(validInputModePayload(value)).toBeNull();
  });

  it('accepts every known target and drops extra fields', () => {
    for (const target of [null, 'archie', 'jumi', 'toy'] as const) {
      expect(validInputModePayload({ generation: 3, target, capture: true, extra: 'ignored' })).toEqual({ generation: 3, target, capture: true });
    }
  });
});

describe('heartbeat payload validation', () => {
  it.each([{ generation: 1, frames: 30 }, { generation: 1, target: null, capture: false }, { generation: 1, frames: -1, target: null, capture: false },
    { generation: 1, frames: 1.5, target: null, capture: false }, { generation: 1, frames: NaN, target: null, capture: false },
    { generation: 1, frames: Infinity, target: null, capture: false }, { generation: 1, frames: 1e9, target: null, capture: false },
    { generation: 1, frames: '30', target: null, capture: false }, { generation: 'x', frames: 30, target: null, capture: false }, 7])('rejects %j', value => {
    expect(validHeartbeat(value)).toBeNull();
  });

  it('returns frames with the input report only', () => {
    expect(validHeartbeat({ generation: 4, frames: 0, target: 'toy', capture: false, pointer: { x: 1 } })).toEqual({ generation: 4, frames: 0, target: 'toy', capture: false });
  });
});

describe('interest payload validation', () => {
  const rect = { x: -20, y: 600, width: 180, height: 200 };
  const square = { x: 300, y: 200, width: 410, height: 410 };
  it('accepts up to eight finite rects that may extend slightly outside the scene', () => {
    expect(validInterest({ generation: 2, rects: [rect, { ...rect, extra: true }] }, scene)).toEqual({ generation: 2, rects: [rect, rect], attention: [] });
    expect(validInterest({ generation: 2, rects: [] }, scene)).toEqual({ generation: 2, rects: [], attention: [] });
    expect(validInterest({ generation: 2, rects: Array.from({ length: MAX_INTEREST_RECTS }, () => rect) }, scene)?.rects).toHaveLength(8);
    expect(validInterest({ generation: 2, rects: [{ x: 0, y: 0, width: 0, height: 0 }] }, scene)?.rects).toHaveLength(1);
  });

  it('keeps attention squares apart from the rects: optional, at most four, the same bounds', () => {
    expect(validInterest({ generation: 2, rects: [rect], attention: [square, { ...square, extra: 1 }] }, scene))
      .toEqual({ generation: 2, rects: [rect], attention: [square, square] });
    expect(validInterest({ generation: 2, rects: [], attention: [] }, scene)).toEqual({ generation: 2, rects: [], attention: [] });
    expect(MAX_ATTENTION_RECTS).toBe(4);
    const full = validInterest({ generation: 2, rects: Array.from({ length: 8 }, () => rect), attention: Array.from({ length: 4 }, () => square) }, scene);
    expect([full?.rects.length, full?.attention.length]).toEqual([8, 4]);
  });

  it.each([
    { attention: null }, { attention: 'all' }, { attention: {} }, { attention: Array.from({ length: 5 }, () => ({ x: 0, y: 0, width: 1, height: 1 })) },
    { attention: [null] }, { attention: [{ x: NaN, y: 0, width: 1, height: 1 }] }, { attention: [{ x: 0, y: 0, width: -1, height: 1 }] },
    { attention: [{ x: 0, y: 0, width: 2561, height: 1 }] }, { attention: [{ x: 0, y: 1441, width: 1, height: 1 }] },
    { attention: [{ x: 0, y: 0, width: 1, height: '1' }] },
  ])('rejects the whole payload for invalid attention %j', patch => {
    expect(validInterest({ generation: 2, rects: [rect], ...patch }, scene)).toBeNull();
  });

  it.each([
    { generation: 2 }, { generation: 2, rects: 'all' }, { generation: 2, rects: {} },
    { generation: 2, rects: Array.from({ length: 9 }, () => ({ x: 0, y: 0, width: 1, height: 1 })) },
    { generation: 2, rects: [null] }, { generation: 2, rects: [[0, 0, 1, 1]] },
    { generation: 2, rects: [{ x: NaN, y: 0, width: 1, height: 1 }] }, { generation: 2, rects: [{ x: 0, y: 0, width: Infinity, height: 1 }] },
    { generation: 2, rects: [{ x: 0, y: 0, width: -1, height: 1 }] }, { generation: 2, rects: [{ x: 0, y: 0, width: 1, height: '1' }] },
    { generation: 2, rects: [{ x: 0, y: 0, width: 2561, height: 1 }] }, { generation: 2, rects: [{ x: 0, y: 0, width: 1, height: 1441 }] },
    { generation: 2, rects: [{ x: -1281, y: 0, width: 1, height: 1 }] }, { generation: 2, rects: [{ x: 0, y: 1441, width: 1, height: 1 }] },
    { generation: -2, rects: [] },
  ])('rejects %j', value => {
    expect(validInterest(value, scene)).toBeNull();
  });
});

describe('scene-state payload validation', () => {
  it('accepts both kittens with known actions and facings, dropping extra fields', () => {
    expect(validSceneState({ generation: 5, pets: { archie: { ...pet, x: 3 }, jumi: { action: 'sleep', facing: 'right', forcedSleep: true }, extra: {} } }))
      .toEqual({ generation: 5, pets: { archie: pet, jumi: { action: 'sleep', facing: 'right', forcedSleep: true } } });
  });

  it.each([
    { generation: 5 }, { generation: 5, pets: { archie: pet } }, { generation: 5, pets: [] },
    { generation: 5, pets: { archie: pet, jumi: { ...pet, action: 'fly' } } }, { generation: 5, pets: { archie: pet, jumi: { ...pet, action: 'toString' } } },
    { generation: 5, pets: { archie: pet, jumi: { ...pet, facing: 'up' } } }, { generation: 5, pets: { archie: pet, jumi: { ...pet, forcedSleep: 1 } } },
    { generation: 5, pets: { archie: pet, jumi: null } }, { generation: 5.5, pets: { archie: pet, jumi: pet } },
  ])('rejects %j', value => {
    expect(validSceneState(value)).toBeNull();
  });

  it('ignores inherited pet entries', () => {
    const pets = Object.assign(Object.create({ jumi: pet }), { archie: pet });
    expect(validSceneState({ generation: 1, pets })).toBeNull();
  });
});
