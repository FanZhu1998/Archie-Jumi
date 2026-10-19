import { describe, expect, it } from 'vitest';
import { summarizeScene } from '../src/rendering/scene-summary';
import type { PetState, SceneSnapshot } from '../src/shared/types';

const pet = (patch: Partial<PetState> = {}): PetState => ({
  id: 'archie', x: 400, y: 300, action: 'idle', actionTime: 0, facing: 'right', forcedSleep: false, visible: true,
  size: 128, target: null, speed: 0, leap: null, held: false, ...patch,
});

describe('smoke scene summary', () => {
  it('reports each kitten, the treats, the toy and the pair with rounded values', () => {
    const snapshot: SceneSnapshot = {
      pets: [
        pet({ action: 'pounce', actionTime: 0.43219, x: 400.04, y: 299.96, speed: 255.5555, facing: 'left', leap: { fromX: 380, fromY: 300, toX: 500, toY: 290, progress: 0.51234, height: 44.8 } }),
        pet({ id: 'jumi', action: 'pet', held: true, x: 812.26, y: 640.3, size: 160 }),
      ],
      toy: { x: 520.123, y: 330.987, petId: 'archie', remaining: 12, automatic: true, held: false },
      pair: null, time: 42, quiet: false,
      treats: [{ petId: 'jumi', x: 900, y: 640, z: 3, phase: 'falling', elapsed: 0.2 }],
    };
    expect(summarizeScene(snapshot, ['jumi'], 1)).toEqual({
      pets: [
        { id: 'archie', action: 'pounce', actionTime: 0.43, held: false, leap: 0.512, x: 400, y: 300, size: 128, facing: 'left', speed: 255.6, visible: true },
        { id: 'jumi', action: 'pet', actionTime: 0, held: true, leap: null, x: 812.3, y: 640.3, size: 160, facing: 'right', speed: 0, visible: true },
      ],
      treats: [{ petId: 'jumi', phase: 'falling' }],
      toy: { x: 520.1, y: 331, held: false, automatic: true },
      pair: null,
      attentive: ['jumi'],
      attention: 1,
    });
  });

  it('names the pair activity and keeps no live references', () => {
    const attentive: ('archie' | 'jumi')[] = ['archie'];
    const snapshot: SceneSnapshot = { pets: [pet()], toy: null, pair: { kind: 'nap', phase: 'together', elapsed: 1 }, time: 1, quiet: false, treats: [] };
    const summary = summarizeScene(snapshot, attentive, 0);
    expect(summary.pair).toBe('nap:together');
    expect(summary.toy).toBeNull();
    attentive.push('jumi');
    expect(summary.attentive).toEqual(['archie']);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });
});
