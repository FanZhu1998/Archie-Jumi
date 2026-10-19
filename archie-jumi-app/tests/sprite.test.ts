import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LEAP_HEIGHT } from '../src/core/engine';
import { CARRY_SWING_FULL_SPEED, LAND_SQUASH_MS, TURN_MS, framePoint, frameUV, identityPose, placementBounds, poseFor, restPlacement, squeezed, type Placement, type Pose, type PoseInput } from '../src/core/motion';
import { ACTIONS, type AnimationPack, type AtlasFrame, type PetState } from '../src/shared/types';
import {
  LAYER_INFLATION, SHADOW_CENTER, SHADOW_RX, SHADOW_RY, drawSprite, footOffset, kittenLayerRect, shadowEllipse, spriteHit, spriteHitBounds, spritePlacement, spriteRect,
  type HitSprite, type SpriteContext,
} from '../src/rendering/sprite';

const bundled = (id: 'archie' | 'jumi') => JSON.parse(readFileSync(`public/pets/${id}/manifest.json`, 'utf8')) as AnimationPack;
const geometry = { frameWidth: 512, frameHeight: 512, anchor: { x: 256, y: 464 } };
const petState = (patch: Partial<PetState> = {}): PetState => ({
  id: 'archie', x: 400, y: 300, action: 'idle', actionTime: 0, facing: 'right', forcedSleep: false, visible: true,
  size: 128, target: null, speed: 0, leap: null, held: false, ...patch,
});
function seeded(seed: number): () => number {
  let value = seed;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) | 0; return (value >>> 0) / 4294967296; };
}
const contains = (outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x - 1e-9 && inner.y >= outer.y - 1e-9 && inner.x + inner.width <= outer.x + outer.width + 1e-9 && inner.y + inner.height <= outer.y + outer.height + 1e-9;

/** A recording 2D context with canvas transform semantics (translate/rotate/scale post-multiply the matrix). */
class RecordingContext implements SpriteContext {
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  private stack: { matrix: number[]; alpha: number; composite: GlobalCompositeOperation }[] = [];
  draws: { args: number[]; matrix: number[]; alpha: number; composite: GlobalCompositeOperation }[] = [];
  save() { this.stack.push({ matrix: [this.a, this.b, this.c, this.d, this.e, this.f], alpha: this.globalAlpha, composite: this.globalCompositeOperation }); }
  restore() {
    const saved = this.stack.pop()!;
    [this.a, this.b, this.c, this.d, this.e, this.f] = saved.matrix;
    this.globalAlpha = saved.alpha;
    this.globalCompositeOperation = saved.composite;
  }
  translate(x: number, y: number) { this.e += this.a * x + this.c * y; this.f += this.b * x + this.d * y; }
  rotate(angle: number) {
    const cos = Math.cos(angle), sin = Math.sin(angle), { a, b, c, d } = this;
    this.a = a * cos + c * sin; this.b = b * cos + d * sin; this.c = c * cos - a * sin; this.d = d * cos - b * sin;
  }
  scale(x: number, y: number) { this.a *= x; this.b *= x; this.c *= y; this.d *= y; }
  drawImage(_image: CanvasImageSource, ...args: number[]) { this.draws.push({ args, matrix: [this.a, this.b, this.c, this.d, this.e, this.f], alpha: this.globalAlpha, composite: this.globalCompositeOperation }); }
  depth() { return this.stack.length; }
}
const apply = (m: number[], x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/** Every distinct pose family the motion layer produces, at its extremes. */
function envelopePoses(size: number): Pose[] {
  const base = (pet: Partial<PetState>, patch: Partial<Omit<PoseInput, 'pet'>> = {}) => poseFor({
    pet: petState({ size, ...pet }), time: 50, reducedMotion: false, velocityX: 0, facingChange: null, actionChange: null, breathPhase: 0, ...patch,
  });
  const poses: Pose[] = [];
  for (const action of ACTIONS) for (let t = 0; t < 3.4; t += 0.05) poses.push(base({ action, actionTime: t, speed: action === 'walk' ? 55 : action === 'trot' ? 102 : 0 }, { time: 50 + t }));
  for (const velocityX of [-5000, -CARRY_SWING_FULL_SPEED, -200, 0, 200, CARRY_SWING_FULL_SPEED, 5000]) poses.push(base({ action: 'carried' }, { velocityX }));
  for (let since = 0; since <= 0.25; since += 0.01) poses.push(base({ action: 'land' }, { actionChange: { from: 'pounce', at: 50 - since } }));
  for (let progress = 0; progress <= 1; progress += 0.05) {
    poses.push(base({ action: 'pounce', actionTime: 0.2 + progress * 0.45, leap: { fromX: 380, fromY: 300, toX: 420, toY: 300, progress, height: LEAP_HEIGHT * size } }));
  }
  for (let ms = 0; ms <= TURN_MS; ms += 5) for (const action of ['walk', 'trot', 'groom', 'pet'] as const) {
    poses.push(base({ action, actionTime: 0.3, speed: 80, facing: 'left' }, { facingChange: { from: 'right', at: 50 - ms / 1000 } }));
  }
  return poses;
}

describe('sprite geometry', () => {
  it('reproduces the 1.0.2 sprite rect with the identity pose, for both bundled packs and every size', () => {
    for (const id of ['archie', 'jumi'] as const) for (const size of [96, 128, 160, 192]) {
      const pack = bundled(id), pet = { x: 640.3, y: 410.7, size };
      const scale = size / (pack.frameHeight * 0.85), width = pack.frameWidth * scale, height = pack.frameHeight * scale;
      const placement = spritePlacement(pet, pack, identityPose('right'));
      const rect = spriteRect(placement);
      expect(rect.x).toBeCloseTo(pet.x - width / 2, 9);
      expect(rect.y).toBeCloseTo(pet.y - height / 2, 9);
      expect(rect.width).toBeCloseTo(width, 9);
      expect(rect.height).toBeCloseTo(height, 9);
      // The drawn rect is the same: a frame point lands where 1.0.2 drew it.
      expect(framePoint(0, 0, placement).x).toBeCloseTo(rect.x, 9);
      expect(framePoint(1, 1, placement).y).toBeCloseTo(rect.y + height, 9);
      // The ground anchor is where the paws stand: centre + footOffset (≈ 0.478 × size).
      expect(placement.anchorY - pet.y).toBeCloseTo(footOffset(pack, size), 9);
      expect(footOffset(pack, size) / size).toBeCloseTo(0.478, 3);
      expect(placement.anchorX).toBeCloseTo(pet.x, 9);
    }
  });

  it('keeps the 1.0.2 ground shadow, which the pose only scales, fades and lowers', () => {
    const pet = { x: 400, y: 300, size: 128 };
    const today = spritePlacement(pet, geometry, identityPose('left')), rect = spriteRect(today);
    expect(shadowEllipse(today)).toEqual({ x: 400, y: rect.y + rect.height * SHADOW_CENTER, rx: rect.width * SHADOW_RX, ry: rect.height * SHADOW_RY, alpha: 1 });
    const carried = poseFor({ pet: petState({ action: 'carried' }), time: 1, reducedMotion: false, velocityX: CARRY_SWING_FULL_SPEED, facingChange: null, actionChange: null, breathPhase: 0 });
    expect(carried.rotation).not.toBe(0);
    const shadow = shadowEllipse(spritePlacement(pet, geometry, carried));
    expect(shadow.x).toBe(400);
    expect(shadow.y).toBeCloseTo(rect.y + rect.height * SHADOW_CENTER + carried.shadowDy, 9);
    expect(shadow.rx).toBeCloseTo(rect.width * SHADOW_RX * carried.shadowScale, 9);
    expect(shadow.alpha).toBe(carried.shadowAlpha);
    expect(carried.shadowDy).toBeGreaterThan(0);
    expect(carried.shadowAlpha).toBeLessThan(1);
  });

  it('draws with exactly the transform frameUV inverts, for random poses including negative scales', () => {
    const random = seeded(7);
    const between = (min: number, max: number) => min + random() * (max - min);
    const frame: AtlasFrame = { x: 1024, y: 512, w: 512, h: 512, duration: 100 };
    const page = { image: {} as CanvasImageSource, offsetX: 0, offsetY: 512 };
    for (let run = 0; run < 300; run++) {
      const pose: Pose = { ...identityPose('right'), dx: between(-20, 20), dy: between(-70, 5), rotation: between(-0.3, 0.3),
        scaleX: (random() < 0.3 ? -1 : 1) * between(0.05, 1.1), scaleY: between(0.85, 1.05) };
      const placement = spritePlacement({ x: between(0, 3000), y: between(0, 1600), size: between(96, 192) }, geometry, pose);
      const context = new RecordingContext(), opacity = between(0, 1), composite = random() < 0.5 ? 'lighter' : 'source-over';
      drawSprite(context, page, frame, placement, opacity, composite);
      expect(context.depth()).toBe(0);
      expect(context.globalAlpha).toBe(1);
      expect(context.globalCompositeOperation).toBe('source-over');
      expect(context.draws).toHaveLength(1);
      const [{ args, matrix, alpha, composite: drawnWith }] = context.draws;
      expect(args.slice(0, 4)).toEqual([frame.x - page.offsetX, frame.y - page.offsetY, frame.w, frame.h]);
      expect(alpha).toBeCloseTo(opacity, 12);
      expect(drawnWith).toBe(composite);
      const [dx, dy, dw, dh] = args.slice(4);
      for (const [u, v] of [[0, 0], [1, 0], [0.5, 0.5], [0.13, 0.91], [1, 1]]) {
        const drawn = apply(matrix, dx + u * dw, dy + v * dh), expected = framePoint(u, v, placement);
        expect(drawn.x).toBeCloseTo(expected.x, 6);
        expect(drawn.y).toBeCloseTo(expected.y, 6);
        const uv = frameUV(drawn.x, drawn.y, placement)!;
        expect(uv.u).toBeCloseTo(u, 6);
        expect(uv.v).toBeCloseTo(v, 6);
      }
    }
  });

  it('sizes kitten layers so no pose clips the sprite or its shadow, with a size that depends only on the kitten size', () => {
    for (const size of [96, 128, 192]) {
      const pet = { x: 900, y: 500, size };
      const reference = kittenLayerRect(spritePlacement(pet, geometry, identityPose('right')), size);
      const rect = spriteRect(spritePlacement(pet, geometry, identityPose('right')));
      expect(reference.width).toBeCloseTo(rect.width * (1 + 2 * LAYER_INFLATION), 9);
      expect(reference.height).toBeCloseTo(rect.height * (1 + 2 * LAYER_INFLATION) + LEAP_HEIGHT * size, 9);
      for (const pose of envelopePoses(size)) {
        const placement = spritePlacement(pet, geometry, pose), layer = kittenLayerRect(placement, size);
        expect(contains(layer, placementBounds(placement))).toBe(true);
        const shadow = shadowEllipse(placement);
        expect(contains(layer, { x: shadow.x - shadow.rx, y: shadow.y - shadow.ry, width: shadow.rx * 2, height: shadow.ry * 2 })).toBe(true);
        // The inflation and leap allowance dominate, so the layer's canvas is never reallocated by a pose.
        expect(layer).toEqual(reference);
      }
    }
  });

  it('still covers an out-of-envelope pose by growing around its transformed bounds', () => {
    const pet = { x: 300, y: 300, size: 128 };
    const pose: Pose = { ...identityPose('right'), rotation: Math.PI / 2, dy: -200, scaleX: 1.5 };
    const placement = spritePlacement(pet, geometry, pose);
    expect(contains(kittenLayerRect(placement, 128), placementBounds(placement))).toBe(true);
  });
});

describe('sprite hit testing through turns and landing squashes', () => {
  // An asymmetric kitten: facing right, its body reaches 0.12 of the frame width behind the anchor
  // line (u = 0.5) and 0.3 in front of it; the left frame mirrors it.
  const right: AtlasFrame = { x: 0, y: 0, w: 512, h: 512, duration: 100 }, left: AtlasFrame = { x: 512, y: 0, w: 512, h: 512, duration: 100 };
  const opaque = (_page: null, frame: AtlasFrame, u: number, v: number) =>
    u >= 0 && v >= 0 && u < 1 && v < 1 && v >= 0.35 && v < 0.9 && (frame === right ? u >= 0.38 && u < 0.8 : u > 0.2 && u <= 0.62);
  const pet = (patch: Partial<PetState>) => petState({ x: 400, y: 300, size: 128, ...patch });
  /** The kitten as the overlay presents it at `input`: drawn frame, placement and (while squeezed) rest placement. */
  function presented(input: PoseInput): HitSprite<null> {
    const pose = poseFor(input), placement = spritePlacement(input.pet, geometry, pose);
    return { page: null, frame: pose.drawFacing === 'right' ? right : left, placement, rest: squeezed(input) ? restPlacement(placement) : null };
  }
  const base = (patch: Partial<PoseInput> & { pet: PetState }): PoseInput => ({ time: 50, reducedMotion: false, velocityX: 0, facingChange: null, actionChange: null, breathPhase: 0, ...patch });

  it('keeps a hovered kitten under a resting cursor for the whole turn, wherever the cursor rests on it', () => {
    const before = spritePlacement(pet({}), geometry, identityPose('right'));
    for (const fraction of [0.5, 0.8, 0.95]) {
      // Behind the centre line of the right-facing kitten, on its body before and after the turn.
      const point = framePoint(0.5 - fraction * 0.12, 0.6, before);
      let exactMisses = 0;
      for (let ms = 0; ms <= TURN_MS + 20; ms += 1) {
        const sprite = presented(base({ pet: pet({ facing: 'left' }), time: 50 + ms / 1000, facingChange: { from: 'right', at: 50 } }));
        expect(spriteHit(sprite, point.x, point.y, true, opaque)).toBe(true);
        if (!spriteHit(sprite, point.x, point.y, false, opaque)) exactMisses++;
        if (ms >= TURN_MS) expect(sprite.rest).toBeNull();
        // Everything spriteHit can return lies inside the bounds published as interest.
        const bounds = spriteHitBounds(sprite)!;
        expect(point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height).toBe(true);
      }
      // Without the hold the squeeze uncovers the cursor for many frames (the overlay would go click-through).
      expect(exactMisses).toBeGreaterThan(fraction * 30);
    }
  });

  it('keeps a hovered kitten under the cursor through the landing squash, and never hits a kitten not yet hovered where nothing is drawn', () => {
    const rest = spritePlacement(pet({ action: 'land' }), geometry, identityPose('right'));
    const top = framePoint(0.5, 0.36, rest);   // just inside the top of the silhouette, which the squash lowers
    let exactMisses = 0;
    for (let ms = 0; ms <= LAND_SQUASH_MS + 20; ms += 2) {
      const sprite = presented(base({ pet: pet({ action: 'land' }), time: 50 + ms / 1000, actionChange: { from: 'carried', at: 50 } }));
      expect(spriteHit(sprite, top.x, top.y, true, opaque)).toBe(true);
      if (!spriteHit(sprite, top.x, top.y, false, opaque)) exactMisses++;
      if (ms > LAND_SQUASH_MS) expect(sprite.rest).toBeNull();
    }
    expect(exactMisses).toBeGreaterThan(10);
    // Off the rest silhouette nothing holds, hovered or not.
    const beside = framePoint(0.9, 0.6, rest);
    const squashed = presented(base({ pet: pet({ action: 'land' }), time: 50.01, actionChange: { from: 'carried', at: 50 } }));
    expect(spriteHit(squashed, beside.x, beside.y, true, opaque)).toBe(false);
    // Outside a squeeze only the exact test counts.
    const still = presented(base({ pet: pet({}) }));
    expect(still.rest).toBeNull();
    expect(spriteHit(still, beside.x, beside.y, true, opaque)).toBe(false);
  });
});
