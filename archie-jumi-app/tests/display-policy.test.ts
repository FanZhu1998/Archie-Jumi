import { describe, expect, it } from 'vitest';
import { displayRecreateReason, snapshotDisplay, type DisplaySnapshot } from '../src/main/display-policy';

const recorded: DisplaySnapshot = { id: 7, workArea: { x: -1200, y: -244, width: 1200, height: 2086 }, scaleFactor: 1.5 };
const changed = (patch: Partial<DisplaySnapshot> & { area?: Partial<DisplaySnapshot['workArea']> } = {}): DisplaySnapshot => ({
  id: patch.id ?? recorded.id, scaleFactor: patch.scaleFactor ?? recorded.scaleFactor, workArea: { ...recorded.workArea, ...patch.area },
});

describe('display-change recreate policy', () => {
  it('keeps a live overlay whose display is unchanged', () => {
    expect(displayRecreateReason(recorded, changed(), true)).toBeNull();
  });

  it.each([
    ['display-id', { id: 8 }],
    ['scale-factor', { scaleFactor: 1.25 }],
    ['work-area', { area: { x: -1199 } }],
    ['work-area', { area: { y: -234 } }],
    ['work-area', { area: { width: 1201 } }],
    ['work-area', { area: { height: 2085 } }],
  ] as const)('recreates for %s changes (%o)', (reason, patch) => {
    expect(displayRecreateReason(recorded, changed(patch), true)).toBe(reason);
  });

  it('recreates when there is no recorded display or no live overlay', () => {
    expect(displayRecreateReason(null, changed(), true)).toBe('no-overlay');
    expect(displayRecreateReason(recorded, changed(), false)).toBe('no-overlay');
  });

  it('records a copy of the work area, not the live display object', () => {
    const live = { id: 7, workArea: { x: 0, y: 0, width: 3072, height: 1680 }, scaleFactor: 1.25, bounds: { x: 0, y: 0, width: 3072, height: 1728 } };
    const snapshot = snapshotDisplay(live);
    expect(snapshot).toEqual({ id: 7, workArea: { x: 0, y: 0, width: 3072, height: 1680 }, scaleFactor: 1.25 });
    live.workArea.height = 1640;
    expect(snapshot.workArea.height).toBe(1680);
    expect(displayRecreateReason(snapshot, snapshotDisplay(live), true)).toBe('work-area');
  });
});
