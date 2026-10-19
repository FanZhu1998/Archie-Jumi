import { describe, expect, it } from 'vitest';
import { HOLD_THRESHOLD_MS, PointerGesture, missedRelease } from '../src/core/input';

describe('lost-pointerup guard', () => {
  it('cancels a capture only for a move with no button pressed', () => {
    expect(missedRelease(true, 0)).toBe(true);
    expect(missedRelease(true, 1)).toBe(false);
    expect(missedRelease(true, 2)).toBe(false);
    expect(missedRelease(true, 3)).toBe(false);
    expect(missedRelease(true, 4)).toBe(false);
  });

  it('never fires without a captured pointer', () => {
    for (const buttons of [0, 1, 2, 3]) expect(missedRelease(false, buttons)).toBe(false);
  });
});

describe('press and hold (hold-to-pet)', () => {
  const at = { x: 100, y: 100 };

  it('becomes a hold at 350 ms without moving past the drag threshold', () => {
    expect(HOLD_THRESHOLD_MS).toBe(350);
    const gesture = new PointerGesture();
    gesture.begin(at, 1000);
    expect(gesture.poll(1000)).toBe('pressed');
    expect(gesture.poll(1349)).toBe('pressed');
    expect(gesture.poll(1350)).toBe('holding');
    expect(gesture.poll(9000)).toBe('holding');
    expect(gesture.end()).toBe('hold');
  });

  it('tolerates jitter inside the drag threshold before and during a hold', () => {
    const gesture = new PointerGesture();
    gesture.begin(at, 0);
    expect(gesture.move({ x: 104, y: 103 })).toBe('pressed');
    expect(gesture.poll(400)).toBe('holding');
    expect(gesture.move({ x: 97, y: 104 })).toBe('holding');
    expect(gesture.end()).toBe('hold');
  });

  it('turns a hold into a drag once the pointer moves past the threshold, and keeps it a drag', () => {
    const gesture = new PointerGesture();
    gesture.begin(at, 0);
    expect(gesture.poll(500)).toBe('holding');
    expect(gesture.move({ x: 110, y: 100 })).toBe('dragging');
    expect(gesture.poll(900)).toBe('dragging');
    expect(gesture.move(at)).toBe('dragging');
    expect(gesture.end()).toBe('drag');
  });

  it('never makes a hold out of a drag that started early', () => {
    const gesture = new PointerGesture();
    gesture.begin(at, 0);
    expect(gesture.move({ x: 100, y: 110 })).toBe('dragging');
    expect(gesture.poll(2000)).toBe('dragging');
    expect(gesture.end()).toBe('drag');
  });

  it('keeps a quick release, or a long press that was never polled, a click', () => {
    const quick = new PointerGesture();
    quick.begin(at, 0);
    expect(quick.poll(200)).toBe('pressed');
    expect(quick.end()).toBe('click');
    const unpolled = new PointerGesture();
    unpolled.begin(at, 0);
    expect(unpolled.end()).toBe('click');
  });

  it('cannot become a hold when the press has no start time', () => {
    const gesture = new PointerGesture();
    gesture.begin(at);
    expect(gesture.poll(1e9)).toBe('pressed');
    expect(gesture.end()).toBe('click');
  });

  it('is inactive before a press and after end or cancel; a new press starts over', () => {
    const gesture = new PointerGesture();
    expect(gesture.poll(1000)).toBe('inactive');
    expect(gesture.move(at)).toBe('inactive');
    expect(gesture.end()).toBe('inactive');
    gesture.begin(at, 0);
    expect(gesture.poll(400)).toBe('holding');
    gesture.cancel();
    expect(gesture.poll(800)).toBe('inactive');
    expect(gesture.end()).toBe('inactive');
    gesture.begin(at, 1000);
    expect(gesture.poll(1100)).toBe('pressed');
    gesture.begin(at, 2000);
    expect(gesture.poll(2349)).toBe('pressed');
    expect(gesture.poll(2350)).toBe('holding');
  });
});
