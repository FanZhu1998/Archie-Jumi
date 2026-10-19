import { describe, expect, it } from 'vitest';
import { DUST_PUFF_S, HEART_SIZE, STATIC_Z_SIZES } from '../src/core/effects';
import { EAT_DURATION } from '../src/core/engine';
import { framePoint, identityPose } from '../src/core/motion';
import { footOffset, spritePlacement, spriteRect } from '../src/rendering/sprite';
import {
  HEART_ORIGIN_DY, HEART_ORIGIN_U, NOSE_U, NOSE_V, PUFF_LIFT, TREAT_EATEN_SCALE, Z_ORIGIN_U, Z_ORIGIN_V,
  kittenFx, kittenFxKeys, noseContact, treatBounds, type KittenFxInput,
} from '../src/rendering/scene-fx';
import type { PetState, TreatState } from '../src/shared/types';

const geometry = { frameWidth: 512, frameHeight: 512, anchor: { x: 256, y: 464 } };
const petState = (patch: Partial<PetState> = {}): PetState => ({
  id: 'archie', x: 400, y: 300, action: 'idle', actionTime: 0, facing: 'right', forcedSleep: false, visible: true,
  size: 128, target: null, speed: 0, leap: null, held: false, ...patch,
});
function input(pet: PetState, patch: Partial<KittenFxInput> = {}): KittenFxInput {
  const placement = spritePlacement(pet, geometry, identityPose(pet.facing));
  return {
    pet, rect: spriteRect(placement), anchor: { x: placement.anchorX, y: placement.anchorY }, time: 100, calm: false,
    actionSince: null, landedAt: null, treat: null, footOffset: footOffset(geometry, pet.size), ...patch,
  };
}
const kinds = (fx: ReturnType<typeof kittenFx>) => fx.particles.map(particle => particle.kind);

describe('kitten effects plan', () => {
  it('shows nothing for a kitten at rest', () => {
    const fx = kittenFx(input(petState({ action: 'sit', actionTime: 3 })));
    expect(fx).toEqual({ particles: [], treat: null, dusting: false });
  });

  it('rises hearts from the 1.0.2 heart point while petting, more while held, one static heart when calm', () => {
    const pet = petState({ action: 'pet', actionTime: 0.5 }), rect = input(pet).rect;
    const click = kittenFx(input(pet));
    expect(kinds(click)).toEqual(['heart']);
    expect(click.particles[0].y).toBeLessThan(rect.y + HEART_ORIGIN_DY);
    const held = kittenFx(input(petState({ action: 'pet', actionTime: 1.3, held: true })));
    expect(kinds(held)).toEqual(['heart', 'heart']);
    for (const calmPet of [pet, petState({ action: 'pet', actionTime: 5, held: true })]) {
      expect(kittenFx(input(calmPet, { calm: true })).particles).toEqual([
        { kind: 'heart', x: calmPet.x + rect.width * HEART_ORIGIN_U, y: rect.y + HEART_ORIGIN_DY, size: HEART_SIZE, alpha: 1, rotation: 0 },
      ]);
    }
  });

  it('lets z rise from the 1.0.2 z point while asleep, timed from falling asleep; two static z when calm', () => {
    const pet = petState({ action: 'sleep', actionTime: 0.2 }), rect = input(pet).rect;
    const early = kittenFx(input(pet, { actionSince: 99.7 }));
    const later = kittenFx(input(pet, { actionSince: 96 }));
    expect(kinds(early).every(kind => kind === 'z')).toBe(true);
    expect(later.particles.length).toBeGreaterThan(early.particles.length);
    const calm = kittenFx(input(pet, { calm: true }));
    expect(calm.particles.map(particle => [particle.size, particle.alpha])).toEqual([[STATIC_Z_SIZES[0], 1], [STATIC_Z_SIZES[1], 1]]);
    expect(calm.particles[0].x).toBeCloseTo(pet.x + rect.width * Z_ORIGIN_U, 9);
    expect(calm.particles[0].y).toBeCloseTo(rect.y + rect.height * Z_ORIGIN_V, 9);
    expect(kittenFx(input(petState({ action: 'wake' }), { calm: true })).particles).toEqual([]);
  });

  it('puffs dust at the paws for a short while after landing, never when calm', () => {
    const pet = petState({ action: 'land', actionTime: 0.1 }), base = input(pet);
    const fx = kittenFx({ ...base, landedAt: 99.9 });
    expect(fx.dusting).toBe(true);
    expect(kinds(fx).every(kind => kind === 'dust')).toBe(true);
    for (const particle of fx.particles) expect(Math.abs(particle.y - base.anchor.y)).toBeLessThan(pet.size * 0.2);
    expect(kittenFx({ ...base, landedAt: 100 - DUST_PUFF_S - 0.001 }).dusting).toBe(false);
    expect(kittenFx({ ...base, landedAt: 99.9, calm: true })).toEqual({ particles: [], treat: null, dusting: false });
  });

  it('draws a dropped treat on its ground line with its height, shrinking while eaten, then crumbs', () => {
    const pet = petState({ action: 'idle' });
    const falling: TreatState = { petId: 'archie', x: 540, y: 300, z: 40, phase: 'falling', elapsed: 0.1 };
    const fx = kittenFx(input(pet, { treat: falling }));
    expect(fx.treat).toEqual({ x: 540, groundY: 300 + footOffset(geometry, 128), z: 40, scale: 1 });
    const bounds = treatBounds(fx.treat!);
    expect(bounds.y + bounds.height).toBeGreaterThan(fx.treat!.groundY);
    expect(bounds.y).toBeLessThan(fx.treat!.groundY - 40);
    const resting: TreatState = { ...falling, z: 0, phase: 'resting', elapsed: 1 };
    const eating = kittenFx(input(petState({ action: 'eat', actionTime: EAT_DURATION / 2 }), { treat: resting }));
    expect(eating.treat!.scale).toBeCloseTo(1 - (1 - TREAT_EATEN_SCALE) / 2, 9);
    expect(kittenFx(input(petState({ action: 'eat', actionTime: 2 }), { treat: resting, calm: true })).treat!.scale).toBe(1);
    const eaten = kittenFx(input(petState({ action: 'sit' }), { treat: { ...resting, phase: 'eaten', elapsed: 0.2 } }));
    expect(eaten.treat).toBeNull();
    expect(kinds(eaten).length).toBeGreaterThan(0);
    expect(kinds(eaten).every(kind => kind === 'crumb')).toBe(true);
    for (const crumb of eaten.particles) expect(crumb.y + crumb.size / 2).toBeLessThanOrEqual(300 + footOffset(geometry, 128) + 1e-9);
    expect(kittenFx(input(petState({ action: 'sit' }), { treat: { ...resting, phase: 'eaten', elapsed: 0.2 }, calm: true })).particles).toEqual([]);
    const big = kittenFx(input(petState({ size: 192 }), { treat: falling, footOffset: footOffset(geometry, 192) }));
    expect(big.treat!.scale).toBe(1.5);
  });

  it('keys the z as ambient and everything else as active', () => {
    const asleep = kittenFx(input(petState({ action: 'sleep' }), { actionSince: 95 }));
    const keys = kittenFxKeys(asleep);
    expect(keys.ambient).not.toBe('');
    const later = kittenFxKeys(kittenFx(input(petState({ action: 'sleep' }), { actionSince: 94.9 })));
    expect(later.active).toBe(keys.active);
    expect(later.ambient).not.toBe(keys.ambient);
    const petting = kittenFxKeys(kittenFx(input(petState({ action: 'pet', actionTime: 0.4 }))));
    expect(petting.ambient).toBe('');
    expect(petting.active).not.toBe(kittenFxKeys(kittenFx(input(petState({ action: 'pet', actionTime: 0.5 })))).active);
  });

  it('places the nose-touch puff between the touching noses', () => {
    const archie = spritePlacement({ x: 500, y: 300, size: 128 }, geometry, identityPose('right'));
    const jumi = spritePlacement({ x: 610, y: 300, size: 128 }, geometry, identityPose('left'));
    const contact = noseContact({ placement: archie, facing: 'right' }, { placement: jumi, facing: 'left' });
    const a = framePoint(NOSE_U, NOSE_V, archie), b = framePoint(1 - NOSE_U, NOSE_V, jumi);
    expect(contact.x).toBeCloseTo((a.x + b.x) / 2, 9);
    expect(contact.y).toBeCloseTo((a.y + b.y) / 2 - PUFF_LIFT, 9);
    expect(contact.x).toBeGreaterThan(500);
    expect(contact.x).toBeLessThan(610);
    expect(contact.y).toBeLessThan(300 + 10);
  });
});
