import { PetEngine } from '../core/engine';
import { PointerGesture, missedRelease } from '../core/input';
import { PET_IDS, type DesktopAdapter, type Bootstrap, type Point, type PetId, type PetCommand, type PetState, type AtlasFrame, type ScenePetCarryOver } from '../shared/types';
import { loadPack, animationFrame, alphaHit, frameKey, requestPage, pageFor, type LoadedPack, type LoadedPage } from './assets';
import { PetSound } from './sound';
import { buildInterestRects, rectsKey, TOY_RADIUS } from './interest';
import { trustedHoverPointer } from './hover-pointer';
interface Presented { pet: PetState; page: LoadedPage; frame: AtlasFrame; x: number; y: number; width: number; height: number }
type Target = PetId | 'toy' | null;
/** Frame-loop self-heal: after this long without a frame, timers drive the loop until rAF fires again. */
const STALL_MS = 500, FALLBACK_FRAME_MS = 33, LIVENESS_CHECK_MS = 100;
export async function startOverlay(adapter: DesktopAdapter): Promise<() => void> {
  document.body.className = 'pet-overlay';
  const canvas = document.createElement('div'); canvas.setAttribute('aria-label', 'Archie and Jumi desktop companions'); canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;touch-action:none';
  document.getElementById('root')!.append(canvas);
  // Keep the native overlay full-screen, but allocate small surfaces only where
  // pets/effects are drawn. A 4K full-screen canvas would multiply GPU buffers.
  const layers = new Map<string, { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }>();
  let context: CanvasRenderingContext2D;
  function beginLayer(id: string, x: number, y: number, width: number, height: number, z: number) {
    let layer = layers.get(id);
    if (!layer) { const element = document.createElement('canvas'); element.style.cssText = 'position:absolute;pointer-events:none'; canvas.append(element); layer = { canvas: element, context: element.getContext('2d')! }; layers.set(id, layer); }
    const element = layer.canvas, dpr = devicePixelRatio || 1;
    element.style.display = 'block'; element.style.left = `${x}px`; element.style.top = `${y}px`; element.style.width = `${width}px`; element.style.height = `${height}px`; element.style.zIndex = String(z);
    const backingWidth = Math.ceil(width * dpr), backingHeight = Math.ceil(height * dpr);
    if (element.width !== backingWidth || element.height !== backingHeight) { element.width = backingWidth; element.height = backingHeight; }
    context = layer.context; context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, element.width, element.height);
    context.setTransform(dpr, 0, 0, dpr, -x * dpr, -y * dpr); context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  }
  let state: Bootstrap = await adapter.getBootstrap();
  const packs = Object.fromEntries(await Promise.all(PET_IDS.map(async id => [id, await loadPack(id)]))) as Record<PetId, LoadedPack>;
  const engine = new PetEngine(state.preferences, state.scene, Math.random, state.carryOver);
  const gesture = new PointerGesture(), sound = new PetSound();
  // `pointer` is the latest real DOM pointer position (the event pointer), recorded at `pointerAt`.
  let pointer = state.cursor, pointerAt = performance.now(), downTarget: Target = null, pointerId: number | null = null, dragOffset: Point = { x: 0, y: 0 }, dragging = false;
  let presented: Presented[] = [], paused = state.hidden || state.paused, last = performance.now(), accumulator = 0, raf = 0, lastDraw = 0, lastSave = 0;
  let lastMode = '', lastVisual = '';
  // Cursor feed from the main process (and when its latest message arrived), and the latest input report (resent with every heartbeat).
  let feedInside = false, feedPointer: Point | null = null, feedAt = Number.NEGATIVE_INFINITY, report: { target: Target; capture: boolean } = { target: null, capture: false };
  let presentedToy: Point | null = null, lastInterest = '';
  let framesSinceBeat = 0, lastFrameAt = performance.now();
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined, livenessTimer: ReturnType<typeof setInterval> | undefined;
  // Read-only counters for the native smoke test (cheap values only).
  const counters = { pointerEvents: 0, cursorMessages: 0, frames: 0, fallbackFrames: 0, drags: 0, lostReleases: 0 };
  Object.defineProperty(window, '__archieJumi', { configurable: true, get: () => ({ ...counters, lastMode }) });
  const point = (event: PointerEvent | MouseEvent): Point => ({ x: event.clientX, y: event.clientY });
  const eventPoint = (event: PointerEvent): Point => { counters.pointerEvents++; pointerAt = performance.now(); return point(event); };
  function resize() {
    // Native overlay bounds are DIP; a browser preview uses the browser viewport.
    if (!window.desktop) state.scene = { width: innerWidth, height: innerHeight };
    engine.resize(state.scene); lastVisual = '';
  }
  function hit(p: Point | null): Target {
    if (!p || state.preferences.quiet || paused) return null;
    const toy = engine.snapshot().toy;
    if (toy && Math.hypot(p.x - toy.x, p.y - toy.y) <= TOY_RADIUS) return 'toy';
    for (const item of [...presented].reverse()) if (alphaHit(item.page, item.frame, (p.x - item.x) / item.width, (p.y - item.y) / item.height)) return item.pet.id;
    return null;
  }
  /**
   * Hover uses the newer of the main-process feed and the latest real pointer event; a real event
   * is trusted only briefly, so after hook loss or a missed move an old position cannot keep the
   * window interactive. Without a feed (browser preview) events are trusted indefinitely; while
   * smoke tests script the cursor, the feed alone decides.
   */
  function trustedPointer(): Point | null {
    if (!adapter.cursorFeed) return pointer;
    return trustedHoverPointer({ event: pointer, eventAt: pointerAt, feed: feedInside ? feedPointer : null, feedAt, now: performance.now(), feedOnly: state.scriptedCursor });
  }
  function updateInput() {
    const target = state.preferences.quiet || paused ? null : downTarget ?? hit(trustedPointer());
    const capture = !state.preferences.quiet && !paused && pointerId !== null;
    report = { target, capture };
    const mode = `${target}:${capture}:${state.generation}`;
    if (mode !== lastMode) { adapter.setInputMode({ generation: state.generation, target, capture }); lastMode = mode; }
    canvas.style.cursor = target ? dragging ? 'grabbing' : 'grab' : 'default';
  }
  function savePositions() { adapter.savePositions(engine.positions()); }
  /** Lets a recreated overlay keep naps and facing (scene carry-over). */
  function reportScene() {
    const pets = Object.fromEntries(engine.snapshot().pets.map(pet => [pet.id, { action: pet.action, facing: pet.facing, forcedSleep: pet.forcedSleep }])) as Record<PetId, ScenePetCarryOver>;
    adapter.reportScene({ generation: state.generation, pets });
  }
  function saveScene() { savePositions(); reportScene(); }
  /** Tells main where cursor positions matter: drawn sprites and the toy, inflated and rounded. Sent only on change. */
  function publishInterest() {
    const rects = buildInterestRects(presented.map(({ x, y, width, height }) => ({ x, y, width, height })), presentedToy);
    const key = rectsKey(rects);
    if (key === lastInterest) return;
    lastInterest = key;
    adapter.setInterest({ generation: state.generation, rects });
  }
  function command(value: PetCommand) {
    engine.command(value);
    if (value.type === 'pet' && state.preferences.sound && !state.preferences.quiet) void sound.purr(state.preferences.volume);
    if (value.type === 'move' || value.type === 'drag-end') savePositions();
  }
  function cancelCapture() {
    if (downTarget === 'toy') {
      const toy = engine.snapshot().toy; if (toy) command({ type: 'toy-move', point: toy, held: false });
    } else if (downTarget && dragging) {
      const pet = engine.snapshot().pets.find(p => p.id === downTarget); if (pet) command({ type: 'drag-end', petId: pet.id, point: pet });
    }
    const old = pointerId; pointerId = null; downTarget = null; dragging = false; gesture.cancel();
    if (old !== null && canvas.hasPointerCapture(old)) canvas.releasePointerCapture(old);
    updateInput();
  }
  const onMove = (event: PointerEvent) => {
    pointer = eventPoint(event);
    // A captured pointer with no buttons pressed means we never saw its release.
    if (missedRelease(pointerId !== null, event.buttons)) { counters.lostReleases++; cancelCapture(); return; }
    if (downTarget === 'toy' && pointerId !== null) command({ type: 'toy-move', point: pointer, held: true });
    else if (downTarget && downTarget !== 'toy' && pointerId !== null && gesture.move(pointer) === 'dragging') {
      const destination = { x: pointer.x - dragOffset.x, y: pointer.y - dragOffset.y };
      if (!dragging) { dragging = true; counters.drags++; command({ type: 'drag-start', petId: downTarget, point: destination }); }
      command({ type: 'drag', petId: downTarget, point: destination });
    }
    updateInput();
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    pointer = eventPoint(event); downTarget = hit(pointer);
    if (!downTarget) return;
    event.preventDefault(); pointerId = event.pointerId; gesture.begin(pointer); canvas.setPointerCapture(event.pointerId);
    if (downTarget === 'toy') command({ type: 'toy-move', point: pointer, held: true });
    else { const pet = engine.snapshot().pets.find(p => p.id === downTarget)!; dragOffset = { x: pointer.x - pet.x, y: pointer.y - pet.y }; }
    updateInput();
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointer = eventPoint(event);
    const target = downTarget, result = gesture.end();
    if (target && target !== 'toy' && result === 'click') command({ type: 'pet', petId: target });
    cancelCapture(); savePositions();
  };
  const onContext = (event: MouseEvent) => {
    event.preventDefault(); const target = hit(point(event));
    if (target && target !== 'toy') adapter.showPetMenu(target);
  };
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', cancelCapture); canvas.addEventListener('lostpointercapture', cancelCapture);
  canvas.addEventListener('pointerleave', () => { if (pointerId === null) { pointer = null; updateInput(); } });
  canvas.addEventListener('contextmenu', onContext);
  function heart(x: number, y: number, scale: number) {
    context.save(); context.translate(x, y); context.scale(scale, scale); context.fillStyle = '#d992a0';
    context.beginPath(); context.moveTo(0, 4); context.bezierCurveTo(-16, -6, -9, -17, 0, -10); context.bezierCurveTo(9, -17, 16, -6, 0, 4); context.fill(); context.restore();
  }
  function render() {
    canvas.style.visibility = state.hidden ? 'hidden' : 'visible';
    const snap = engine.snapshot();
    for (const pet of snap.pets) if (pet.visible) void requestPage(packs[pet.id], pet.action).catch(() => {});
    const visual = JSON.stringify([snap.pets.map(p => { const pack = packs[p.id], page = pageFor(pack, p.action), action = pack.manifest.pages?.[page.action] ? page.action : p.action; return [p.id, p.visible, p.x, p.y, p.size, p.action, frameKey(animationFrame(pack.manifest, action, p.facing, state.preferences.reducedMotion ? 0 : p.actionTime)), p.action === 'pet' && !state.preferences.reducedMotion ? p.actionTime : 0]; }), snap.toy?.x, snap.toy?.y]);
    if (visual === lastVisual) { if (!lastInterest) publishInterest(); updateInput(); return; }
    lastVisual = visual;
    for (const layer of layers.values()) layer.canvas.style.display = 'none';
    presented = [];
    for (const pet of snap.pets.filter(p => p.visible).sort((a, b) => a.y - b.y)) {
      const pack = packs[pet.id], page = pageFor(pack, pet.action), action = pack.manifest.pages?.[page.action] ? page.action : pet.action;
      const frame = animationFrame(pack.manifest, action, pet.facing, state.preferences.reducedMotion ? 0 : pet.actionTime);
      const scale = pet.size / (pack.manifest.frameHeight * 0.85), width = pack.manifest.frameWidth * scale, height = pack.manifest.frameHeight * scale;
      const x = pet.x - width / 2, y = pet.y - height / 2;
      beginLayer(pet.id, x - 35, y - 55, width + 70, height + 90, Math.round(pet.y));
      context.fillStyle = '#302f3d15'; context.beginPath(); context.ellipse(pet.x, y + height * 0.9, width * 0.31, height * 0.045, 0, 0, Math.PI * 2); context.fill();
      context.drawImage(page.image, frame.x - page.offsetX, frame.y - page.offsetY, frame.w, frame.h, x, y, width, height);
      presented.push({ pet, page, frame, x, y, width, height });
      if (pet.action === 'pet') heart(pet.x + width * 0.23, y + 10 - (state.preferences.reducedMotion ? 0 : pet.actionTime * 10), 0.8);
      if (pet.action === 'sleep') { context.fillStyle = '#827da6'; context.font = '600 15px Segoe UI'; context.fillText('z', pet.x + width * 0.25, y + height * 0.32); context.font = '600 11px Segoe UI'; context.fillText('z', pet.x + width * 0.32, y + height * 0.21); }
      if (pet.action === 'eat') { const tx = pet.x + (pet.facing === 'right' ? 1 : -1) * width * 0.25, ty = y + height * 0.84; context.fillStyle = '#db9c6c'; context.beginPath(); context.roundRect(tx - 7, ty - 4, 14, 8, 3); context.fill(); }
    }
    presentedToy = snap.toy ? { x: snap.toy.x, y: snap.toy.y } : null;
    if (snap.toy) {
      const { x, y } = snap.toy;
      beginLayer('toy', x - 32, y - 25, 90, 55, 100000);
      context.strokeStyle = '#b396bd'; context.lineWidth = 2; context.beginPath(); context.moveTo(x + 12, y + 6); context.bezierCurveTo(x + 23, y + 25, x + 43, y - 12, x + 52, y + 14); context.stroke();
      context.fillStyle = '#c4a4c8'; context.beginPath(); context.arc(x, y, 17, 0, Math.PI * 2); context.fill();
      context.save(); context.beginPath(); context.arc(x, y, 16, 0, Math.PI * 2); context.clip(); context.strokeStyle = '#9b7fa5'; context.lineWidth = 1.2;
      for (let i = -18; i < 25; i += 6) { context.beginPath(); context.ellipse(x + i * 0.3, y, 7 + i * 0.3, 21, -0.55, 0, Math.PI * 2); context.stroke(); }
      context.restore();
    }
    publishInterest(); updateInput();
  }
  /** Exactly one requestAnimationFrame may be pending: cancel before re-requesting. */
  function requestFrame() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(onAnimationFrame);
  }
  function onAnimationFrame(now: number) { raf = 0; stopFallback(); frame(now); }
  function frame(now: number) {
    if (paused) return;
    counters.frames++; framesSinceBeat++; lastFrameAt = performance.now();
    const elapsed = Math.max(0, Math.min((now - last) / 1000, 0.1)); last = now; accumulator += elapsed;
    while (accumulator >= 1 / 30) { engine.step(1 / 30); accumulator -= 1 / 30; }
    if (now - lastDraw >= 1000 / 30 - 1) { render(); lastDraw = now; }
    if (now - lastSave > 5000) { saveScene(); lastSave = now; }
    requestFrame();
  }
  // Frame-loop self-heal: requestAnimationFrame can starve (for example while the compositor
  // treats the window as occluded). Timers then drive the loop until rAF fires again.
  function stopFallback() {
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  }
  function fallbackFrame() {
    fallbackTimer = undefined;
    if (paused) return;
    counters.fallbackFrames++;
    frame(performance.now());
    if (!paused && fallbackTimer === undefined) fallbackTimer = setTimeout(fallbackFrame, FALLBACK_FRAME_MS);
  }
  function checkLiveness() {
    if (!paused && fallbackTimer === undefined && performance.now() - lastFrameAt >= STALL_MS) fallbackTimer = setTimeout(fallbackFrame, 0);
  }
  function resume() {
    paused = false; last = performance.now(); accumulator = 0; lastFrameAt = last;
    // Resynchronize main after any pause or update: resend the input report and the interest region.
    lastMode = ''; lastInterest = '';
    requestFrame();
    livenessTimer ??= setInterval(checkLiveness, LIVENESS_CHECK_MS);
  }
  /** Stops the frame loop and its fallback; returns whether the loop was running. */
  function pause() {
    const wasRunning = !paused;
    cancelCapture(); paused = true; if (raf) cancelAnimationFrame(raf); raf = 0; sound.stop();
    stopFallback();
    if (livenessTimer !== undefined) clearInterval(livenessTimer);
    livenessTimer = undefined;
    // Main stops its cursor feed while paused, so the last fed position is no longer current.
    feedInside = false; feedPointer = null;
    updateInput();
    return wasRunning;
  }
  const offState = adapter.onBootstrap(next => {
    const old = state; state = next;
    if (!window.desktop) state.scene = { width: innerWidth, height: innerHeight };
    engine.setPreferences(next.preferences);
    if (next.scene.width !== old.scene.width || next.scene.height !== old.scene.height) resize();
    if (next.preferences.quiet || !next.preferences.sound) sound.stop();
    if (next.preferences.quiet) cancelCapture();
    if (next.hidden || next.paused) { if (pause()) saveScene(); } else resume();
    render();
  });
  const offCommands = adapter.onCommand(command);
  const offLifecycle = adapter.onLifecycle(event => {
    if (event.type === 'pause') { pause(); saveScene(); }
    else if (event.type === 'cancel-input') cancelCapture();
    else { if (event.cursor) { pointer = event.cursor; pointerAt = performance.now(); } resume(); }
  });
  const offCursor = adapter.onCursor(message => {
    if (!message || message.generation !== state.generation) return;
    counters.cursorMessages++; feedAt = performance.now();
    if (message.inside === true && Number.isFinite(message.x) && Number.isFinite(message.y)) { feedInside = true; feedPointer = { x: message.x, y: message.y }; }
    else { feedInside = false; feedPointer = null; }
    // While a pointer is captured, real events drive the drag; the feed state stays current for after release.
    if (pointerId === null) updateInput();
  });
  resize(); render(); adapter.ready(state.generation);
  if (!paused) resume();
  const heartbeat = setInterval(() => {
    adapter.heartbeat({ generation: state.generation, frames: framesSinceBeat, target: report.target, capture: report.capture });
    framesSinceBeat = 0;
  }, 1000);
  window.addEventListener('resize', resize);
  window.addEventListener('beforeunload', savePositions);
  return () => { pause(); clearInterval(heartbeat); offState(); offCommands(); offLifecycle(); offCursor(); delete (window as unknown as Record<string, unknown>).__archieJumi; window.removeEventListener('resize', resize); for (const pack of Object.values(packs)) for (const page of pack.cache.values()) page.image.close(); canvas.remove(); };
}
