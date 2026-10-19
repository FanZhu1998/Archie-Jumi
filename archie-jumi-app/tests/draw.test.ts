import { describe, expect, it } from 'vitest';
import { HEART_SIZE, type Particle } from '../src/core/effects';
import { HEART_COLOR, TREAT_COLOR, Z_COLOR, drawParticles, drawShadow, drawToy, drawTreat, toyBounds } from '../src/rendering/draw';
import { SHADOW_COLOR } from '../src/rendering/sprite';
import { THREAD_REST, ToyVisual } from '../src/rendering/toy-visual';

/** Records every context call with the fill state at that moment; property writes are kept as state. */
function recorder() {
  const calls: { name: string; args: unknown[]; fillStyle: unknown; alpha: number; font: string }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '#000', font: '10px sans-serif' };
  const stack: Record<string, unknown>[] = [];
  const gradient = { addColorStop: () => {} };
  const context = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ name: key, args, fillStyle: target.fillStyle, alpha: target.globalAlpha as number, font: target.font as string });
        if (key === 'save') stack.push({ ...target });
        if (key === 'restore') Object.assign(target, stack.pop());
        return key === 'createRadialGradient' ? gradient : undefined;
      };
    },
    set(target, key: string, value) { target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { context, calls, names: () => calls.map(call => call.name) };
}
const particle = (patch: Partial<Particle>): Particle => ({ kind: 'heart', x: 10, y: 20, size: HEART_SIZE, alpha: 1, rotation: 0, ...patch });

describe('overlay drawing', () => {
  it('draws a static heart exactly like 1.0.2 (scale 0.8 around its point, no rotation)', () => {
    const { context, calls, names } = recorder();
    drawParticles(context, [particle({})]);
    expect(names()).toEqual(['save', 'translate', 'scale', 'beginPath', 'moveTo', 'bezierCurveTo', 'bezierCurveTo', 'fill', 'restore']);
    expect(calls[1].args).toEqual([10, 20]);
    expect(calls[2].args).toEqual([0.8, 0.8]);
    expect(calls[7].fillStyle).toBe(HEART_COLOR);
  });

  it('draws z glyphs with one font string, scaled to their size, and skips invisible particles', () => {
    const { context, calls, names } = recorder();
    drawParticles(context, [particle({ kind: 'z', size: 15 }), particle({ kind: 'z', size: 9, rotation: 0.2 }), particle({ kind: 'heart', alpha: 0 }), particle({ kind: 'dust', size: 0 })]);
    const texts = calls.filter(call => call.name === 'fillText');
    expect(texts).toHaveLength(2);
    expect(new Set(texts.map(call => call.font)).size).toBe(1);
    expect(texts[0].font).toBe('600 15px Segoe UI');
    expect(texts[0].fillStyle).toBe(Z_COLOR);
    expect(texts[0].args).toEqual(['z', 0, 0]);
    expect(calls.filter(call => call.name === 'scale').map(call => call.args)).toEqual([[1, 1], [0.6, 0.6]]);
    expect(names().filter(name => name === 'rotate')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'save').length).toBe(calls.filter(call => call.name === 'restore').length);
  });

  it('draws soft dots and crumbs centred on their particle', () => {
    const { context, calls } = recorder();
    drawParticles(context, [particle({ kind: 'dust', size: 8, alpha: 0.5 }), particle({ kind: 'puff', size: 6 }), particle({ kind: 'crumb', size: 4, rotation: 1 })]);
    const arcs = calls.filter(call => call.name === 'arc');
    expect(arcs.map(call => call.args.slice(0, 3))).toEqual([[0, 0, 4], [0, 0, 3]]);
    expect(calls.filter(call => call.name === 'fill')[0].alpha).toBe(0.5);
    expect(calls.find(call => call.name === 'roundRect')!.args.slice(0, 2)).toEqual([-2, -1.6]);
  });

  it('draws the ground shadow, under what is already drawn (destination-over) when asked, inside save/restore', () => {
    const { context, calls, names } = recorder();
    const state = context as unknown as Record<string, unknown>;
    state.globalCompositeOperation = 'source-over';
    const writes: unknown[] = [];
    const spy = new Proxy(state, {
      set(target, key: string, value) { if (key === 'globalCompositeOperation') writes.push(value); target[key] = value; return true; },
      get(target, key: string) { return (context as unknown as Record<string, unknown>)[key] ?? target[key]; },
    }) as unknown as CanvasRenderingContext2D;
    drawShadow(spy, { x: 50, y: 80, rx: 20, ry: 4, alpha: 0.5 }, 'destination-over');
    expect(names()).toEqual(['save', 'beginPath', 'ellipse', 'fill', 'restore']);
    expect(calls[2].args).toEqual([50, 80, 20, 4, 0, 0, Math.PI * 2]);
    expect(calls[3]).toMatchObject({ fillStyle: SHADOW_COLOR, alpha: 0.5 });
    expect(writes).toEqual(['destination-over']);
    expect(state.globalCompositeOperation).toBe('source-over');   // restored
    // The default draws over with no composite change; a degenerate shadow draws nothing.
    drawShadow(spy, { x: 0, y: 0, rx: 2, ry: 1, alpha: 1 });
    drawShadow(spy, { x: 0, y: 0, rx: 0, ry: 1, alpha: 1 }, 'destination-over');
    expect(writes).toEqual(['destination-over']);
    expect(names().filter(name => name === 'fill')).toHaveLength(2);
  });

  it('draws a resting treat on its ground line', () => {
    const { context, calls } = recorder();
    drawTreat(context, { x: 100, groundY: 200, z: 0, scale: 1 });
    const glyph = calls.filter(call => call.name === 'roundRect').at(-1)!;
    expect(glyph.args).toEqual([93, 192, 14, 8, 3]);
    expect(calls.filter(call => call.name === 'fill').at(-1)!.fillStyle).toBe(TREAT_COLOR);
  });

  it('draws the resting toy with the 1.0.2 thread and stripes, and bounds every drawn part', () => {
    const view = new ToyVisual().observe({ x: 300, y: 200, petId: 'jumi', remaining: 10, automatic: false, held: false }, 0, true)!;
    const { context, calls } = recorder();
    drawToy(context, view);
    expect(calls.find(call => call.name === 'moveTo')!.args).toEqual([312, 206]);
    expect(calls.find(call => call.name === 'bezierCurveTo')!.args).toEqual([323, 225, 343, 188, 352, 214]);
    expect(calls.filter(call => call.name === 'rotate')).toHaveLength(0);
    expect(calls.filter(call => call.name === 'ellipse')[0].args).toEqual([-18 * 0.3, 0, 7 - 18 * 0.3, 21, -0.55, 0, Math.PI * 2]);
    const bounds = toyBounds(view);
    for (const point of [{ x: 283, y: 183 }, { x: 317, y: 217 }, ...THREAD_REST.map(rest => ({ x: 300 + rest.x, y: 200 + rest.y }))]) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.x);
      expect(point.y).toBeGreaterThanOrEqual(bounds.y);
      expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
  });
});
