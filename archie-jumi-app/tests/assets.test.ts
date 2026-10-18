import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIONS, PET_IDS, type AnimationPack } from '../src/shared/types';
import { alphaHit, animationFrame, frameKey, validatePack } from '../src/rendering/assets';
const pack = (id: 'archie' | 'jumi') => JSON.parse(readFileSync(`public/pets/${id}/manifest.json`, 'utf8')) as AnimationPack;
describe('bundled animation contract', () => {
  for (const id of PET_IDS) it(`${id} has valid in-bounds frames for every action and direction`, () => {
    const manifest = pack(id); validatePack(manifest, id);
    const png = readFileSync(`public/pets/${id}/atlas.png`), width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    expect(width * height).toBeLessThanOrEqual(30_000_000);
    for (const action of ACTIONS) for (const direction of ['left', 'right'] as const) for (const frame of manifest.animations[action][direction].frames) {
      expect(frame.x + frame.w).toBeLessThanOrEqual(width); expect(frame.y + frame.h).toBeLessThanOrEqual(height);
      expect(frame.duration).toBeGreaterThan(0);
    }
  });
  it('uses authored milliseconds and loops independently of display refresh', () => {
    const manifest = pack('archie'), clip = manifest.animations.walk.right;
    const seconds = clip.frames[0].duration / 1000;
    expect(animationFrame(manifest, 'walk', 'right', seconds + 0.001)).toEqual(clip.frames[1]);
    const duration = clip.frames.reduce((n, f) => n + f.duration, 0) / 1000;
    expect(animationFrame(manifest, 'walk', 'right', duration + 0.001)).toEqual(clip.frames[0]);
  });
  it('rejects unsupported versions, missing actions and non-local atlas references', () => {
    const bad = pack('jumi'); (bad as { formatVersion: number }).formatVersion = 2;
    expect(() => validatePack(bad, 'jumi')).toThrow();
    const missing = pack('jumi'); delete (missing.animations as Partial<typeof missing.animations>).carried;
    expect(() => validatePack(missing, 'jumi')).toThrow();
    const remote = pack('jumi'); remote.atlas = 'https://example.com/pet.png';
    expect(() => validatePack(remote, 'jumi')).toThrow();
  });
  it('passes transparent pixels through and excludes positions outside the rendered frame', () => {
    const manifest = pack('archie'), frame = manifest.animations.idle.right.frames[0], mask = new Uint8Array(64 * 64);
    mask[32 * 64 + 32] = 1;
    const loaded = { manifest, image: {} as HTMLImageElement, masks: new Map([[frameKey(frame), mask]]) };
    expect(alphaHit(loaded, frame, 0.5, 0.5)).toBe(true);
    expect(alphaHit(loaded, frame, 0, 0)).toBe(false);
    expect(alphaHit(loaded, frame, 1, 0.5)).toBe(false);
    expect(alphaHit(loaded, frame, -0.1, 0.5)).toBe(false);
  });
});
