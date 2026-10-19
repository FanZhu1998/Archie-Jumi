import { describe, expect, it } from 'vitest';
import { POSITION_EPSILON, normalizePreferences, samePositions, validCommand } from '../src/shared/validation';
import { defaultPreferences } from '../src/shared/defaults';

const scene = { width: 1280, height: 720 };

describe('IPC command validation', () => {
  it.each([null, undefined, 12, 'pet', true, [], {}, { type: 'eval', source: 'process.exit()' },
    { type: 'pet', petId: '../state.json' }, { type: 'pet', petId: '__proto__' },
    { type: 'pet', petId: 'Archie' }, { type: 'pair', kind: 'unknown' }, { type: 'pair' },
    { type: 'move', petId: 'archie', point: { x: NaN, y: 20 } },
    { type: 'drag', petId: 'archie', point: { x: 20, y: Infinity } },
    { type: 'drag-end', petId: 'archie', point: { x: '20', y: 20 } },
    { type: 'drag-start', petId: 'archie', point: [20, 20] },
    { type: 'toy-move', point: { x: 20, y: 20 }, held: 'yes' },
  ])('rejects malformed or unauthorized command %#', value => {
    expect(validCommand(value, scene)).toBeNull();
  });

  it.each(['pet', 'treat', 'nap', 'wake', 'hide', 'show'])('allowlists %s and strips extra payloads', type => {
    expect(validCommand({ type, petId: 'archie', run: 'unsafe', point: { x: 0, y: 0 } }, scene))
      .toEqual({ type, petId: 'archie' });
  });

  it.each(['move', 'drag-start', 'drag', 'drag-end'])('clamps %s to finite scene coordinates', type => {
    expect(validCommand({ type, petId: 'jumi', point: { x: -9000, y: Number.MAX_VALUE }, other: 'discard' }, scene))
      .toEqual({ type, petId: 'jumi', point: { x: 0, y: 720 } });
  });

  it('accepts only supported pair kinds and explicit automatic-play booleans', () => {
    expect(validCommand({ type: 'pair', kind: 'nose_touch', petId: 'bogus' }, scene)).toEqual({ type: 'pair', kind: 'nose_touch' });
    expect(validCommand({ type: 'pair', kind: 'nap' }, scene)).toEqual({ type: 'pair', kind: 'nap' });
    expect(validCommand({ type: 'play', petId: 'jumi', automatic: 'true' }, scene)).toEqual({ type: 'play', petId: 'jumi', automatic: false });
    expect(validCommand({ type: 'play', petId: 'jumi', automatic: true }, scene)).toEqual({ type: 'play', petId: 'jumi', automatic: true });
    expect(validCommand({ type: 'end-play', extra: '__proto__' }, scene)).toEqual({ type: 'end-play' });
  });

  it('validates toy capture state while bounding its target', () => {
    expect(validCommand({ type: 'toy-move', point: { x: 5000, y: -1000 }, held: false }, scene))
      .toEqual({ type: 'toy-move', point: { x: 1280, y: 0 }, held: false });
  });

  it('accepts come here with a point clipped to the scene', () => {
    expect(validCommand({ type: 'come', petId: 'jumi', point: { x: -50, y: 9000 }, run: 'unsafe' }, scene))
      .toEqual({ type: 'come', petId: 'jumi', point: { x: 0, y: 720 } });
    expect(validCommand({ type: 'come', petId: 'archie', point: { x: 640.5, y: 360 } }, scene))
      .toEqual({ type: 'come', petId: 'archie', point: { x: 640.5, y: 360 } });
    for (const point of [undefined, null, { x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: '1', y: 1 }, [1, 1]]) {
      expect(validCommand({ type: 'come', petId: 'archie', point }, scene)).toBeNull();
    }
    expect(validCommand({ type: 'come', petId: 'tom', point: { x: 1, y: 1 } }, scene)).toBeNull();
  });

  it('never accepts the local-only hold-to-pet commands over IPC', () => {
    for (const type of ['pet-hold', 'pet-release']) {
      expect(validCommand({ type, petId: 'archie' }, scene)).toBeNull();
      expect(validCommand({ type, petId: 'jumi', point: { x: 1, y: 1 } }, scene)).toBeNull();
    }
  });
});

describe('curious preference (1.1.0)', () => {
  it('defaults to on, including for saves written before it existed', () => {
    expect(defaultPreferences().curious).toBe(true);
    const older = JSON.parse(JSON.stringify(defaultPreferences()));
    delete older.curious;
    expect(normalizePreferences(older).curious).toBe(true);
    expect(normalizePreferences({}).curious).toBe(true);
    // A base copy from before the field existed falls back to on as well.
    const base = { ...defaultPreferences() } as Partial<ReturnType<typeof defaultPreferences>>;
    delete base.curious;
    expect(normalizePreferences({ sound: true }, base as ReturnType<typeof defaultPreferences>).curious).toBe(true);
  });

  it('keeps an explicit choice through partial updates and never coerces other types', () => {
    const off = normalizePreferences({ curious: false });
    expect(off.curious).toBe(false);
    expect(normalizePreferences({ volume: 0.5, quiet: true }, off).curious).toBe(false);
    expect(normalizePreferences({ curious: true }, off).curious).toBe(true);
    for (const value of ['false', 'true', 0, 1, null, {}, []]) {
      expect(normalizePreferences({ curious: value }, off).curious).toBe(false);
      expect(normalizePreferences({ curious: value }).curious).toBe(true);
    }
  });
});

describe('saved positions', () => {
  it('counts only a real move of either kitten as a change, so unchanged reports never rewrite state.json', () => {
    const base = defaultPreferences();
    const at = (patch: object) => normalizePreferences({ pets: patch }, base);
    expect(samePositions(at({}), base)).toBe(true);
    expect(samePositions({ ...base, sound: true, volume: 0.2 }, base)).toBe(true);
    expect(samePositions(at({ archie: { position: { x: 0.35 + POSITION_EPSILON / 2, y: 0.72 - POSITION_EPSILON / 2 } } }), base)).toBe(true);
    expect(samePositions(at({ archie: { position: { x: 0.35 + 2 * POSITION_EPSILON, y: 0.72 } } }), base)).toBe(false);
    expect(samePositions(at({ jumi: { position: { x: 0.65, y: 0.5 } } }), base)).toBe(false);
    // A malformed report normalizes to the current positions: no change.
    expect(samePositions(at({ archie: { position: { x: Number.NaN, y: 'far' } } }), base)).toBe(true);
  });
});

describe('preference normalization', () => {
  it.each([null, undefined, 10, false, [], 'bad config'])('uses safe defaults for non-object preferences %#', value => {
    expect(normalizePreferences(value)).toEqual(defaultPreferences());
  });

  it('bounds sizes, volume, personality and positions, while replacing non-finite values', () => {
    const result = normalizePreferences({ volume: 100, pets: {
      archie: { size: -1, personality: { energy: 99, playfulness: -9, sociability: NaN }, position: { x: Infinity, y: -500 } },
      jumi: { size: 9999, personality: { energy: -Infinity }, position: { x: 100, y: '0.5' } },
    } });
    expect(result.volume).toBe(1);
    expect(result.pets.archie).toMatchObject({ size: 96, personality: { energy: 1, playfulness: 0, sociability: 0.65 }, position: { x: 0.35, y: 0 } });
    expect(result.pets.jumi).toMatchObject({ size: 192, personality: { energy: 0.7 }, position: { x: 1, y: 0.72 } });
  });

  it('does not coerce strings, numbers or objects to privacy-sensitive booleans', () => {
    const result = normalizePreferences({ sound: 'true', launchAtLogin: 1, quiet: {}, reducedMotion: [], pets: { archie: { visible: 'false' } } });
    expect(result).toMatchObject({ sound: false, launchAtLogin: false, quiet: false, reducedMotion: false });
    expect(result.pets.archie.visible).toBe(true);
  });

  it('supports partial updates without mutating or aliasing the base', () => {
    const base = defaultPreferences();
    base.pets.jumi.name = 'Jum Jum';
    base.selectedDisplay = 'secondary-display';
    const result = normalizePreferences({ pets: { archie: { personality: { energy: 0.9 } } }, selectedDisplay: null }, base);
    expect(result.pets.archie.personality.energy).toBe(0.9);
    expect(result.pets.archie.personality.sociability).toBe(base.pets.archie.personality.sociability);
    expect(result.pets.jumi.name).toBe('Jum Jum');
    expect(result.selectedDisplay).toBeNull();
    result.pets.jumi.position.x = 0;
    expect(base.pets.jumi.position.x).toBe(0.65);
    expect(base.pets.archie.personality.energy).toBe(0.35);
    expect(base.selectedDisplay).toBe('secondary-display');
  });

  it('trims and limits user labels and ignores unknown fields and prototype payloads', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"executable":"malicious.js","pets":{"archie":{"name":"  Archie  ","arbitrary":"ignored"},"jumi":{"name":""}}}');
    const result = normalizePreferences(value);
    expect(result.pets.archie.name).toBe('Archie');
    expect(result.pets.jumi.name).toBe('Jumi');
    expect('executable' in result).toBe(false);
    expect('polluted' in result).toBe(false);
    expect('arbitrary' in result.pets.archie).toBe(false);
    const long = normalizePreferences({ shortcut: 'X'.repeat(1000), selectedDisplay: 'S'.repeat(1000), pets: { archie: { name: 'A'.repeat(1000) } } });
    expect(long.shortcut).toHaveLength(100);
    expect(long.selectedDisplay).toHaveLength(80);
    expect(long.pets.archie.name).toHaveLength(32);
  });
});
