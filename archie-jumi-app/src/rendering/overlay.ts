import { PetEngine } from '../core/engine';
import { PointerGesture, missedRelease } from '../core/input';
import { clipSeconds, identityPose, poseFor, poseKey, restPlacement, squeezed, type Placement, type PoseInput } from '../core/motion';
import { heartPuff, particleBounds } from '../core/effects';
import { PET_IDS, type DesktopAdapter, type Bootstrap, type Point, type PetId, type PetCommand, type PetState, type ScenePetCarryOver, type Facing, type Rect, type SceneSnapshot } from '../shared/types';
import { loadPack, animationFrame, alphaHit, frameKey, requestPage, drawablePage, clipDurationMs, closePage, type LoadedPack, type LoadedPage } from './assets';
import { PetSound } from './sound';
import { attentionRect, buildInterest, inflateRect, interestKey, TOY_RADIUS } from './interest';
import { trustedHoverPointer } from './hover-pointer';
import { drawSprite, footOffset, kittenLayerRect, shadowEllipse, spriteHit, spriteHitBounds, spritePlacement, spriteRect, type HitSprite } from './sprite';
import { fitDeviceBox, unionRects, type DeviceBox } from './layer-box';
import { KittenTrack, PairTrack } from './kitten-track';
import { ToyVisual } from './toy-visual';
import { FramePacer, layerChange, sceneAmbientIntervalMs, type LayerKeys } from './pacing';
import { kittenFx, kittenFxKeys, noseContact, particlesKey, treatBounds } from './scene-fx';
import { drawParticles, drawShadow, drawToy, drawTreat, toyBounds } from './draw';
import { HoldToPet, PurrControl, purrLoopWanted } from './hold-pet';
import { summarizeScene } from './scene-summary';
/**
 * A kitten as drawn last. Hit testing uses exactly this (spriteHit): the frame shown (during a
 * crossfade the more opaque of the two) through the pose's inverse transform, and while a turn or
 * landing squash squeezes the kitten, its rest placement for the kitten already hovered or pressed.
 */
interface Presented extends HitSprite<LoadedPage> { pet: PetState; z: number }
type Target = PetId | 'toy' | null;
/**
 * A canvas layer: its device-pixel box, whether it is displayed, the keys of what it shows (null =
 * redraw) and when it last drew an active (not ambient-only) change, renderer ms.
 */
interface Layer { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; box: DeviceBox | null; shown: boolean; drawn: LayerKeys | null; z: number; activeAt: number }
/** Frame-loop self-heal: after this long without a frame, timers drive the loop until rAF fires again. */
const STALL_MS = 500, FALLBACK_FRAME_MS = 33, LIVENESS_CHECK_MS = 100;
/** Layer stacking: kittens by depth (each with its effects just above it), then the nose-touch puff, then the toy. */
const KITTEN_Z = 10, PAIR_FX_Z = 90, TOY_Z = 100;
/** Effects layers keep this much room around their particles, DIP. */
const FX_PAD = 3;
/** Before its first frame the overlay waits at most this long for each visible kitten's page (a restored nap), ms. */
const FIRST_PAGES_WAIT_MS = 400;
const quantize = (value: number, step: number) => Math.round(value / step);

/**
 * Whether a contextmenu event may open the kitten menu. Never while a primary press is captured, and
 * never for touch: Chromium turns a still touch long-press (the hold-to-pet gesture) into a
 * contextmenu, and the native menu's modal loop would take the capture and end the held pet. Mouse
 * right-clicks (onDown ignores non-primary buttons) and the tray menu are unaffected.
 */
export function kittenMenuWanted(event: Event, pressing: boolean): boolean {
  if (pressing) return false;
  const source = event as Event & { pointerType?: unknown; sourceCapabilities?: { firesTouchEvents?: unknown } | null };
  return source.pointerType !== 'touch' && source.sourceCapabilities?.firesTouchEvents !== true;
}
export async function startOverlay(adapter: DesktopAdapter): Promise<() => void> {
  document.body.className = 'pet-overlay';
  const canvas = document.createElement('div'); canvas.setAttribute('aria-label', 'Archie and Jumi desktop companions'); canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;touch-action:none';
  document.getElementById('root')!.append(canvas);
  // Keep the native overlay full-screen, but allocate small surfaces only where
  // pets/effects are drawn. A 4K full-screen canvas would multiply GPU buffers.
  // Every layer is non-interactive (pointer-events: none); only hit() decides what the pointer is over.
  const layers = new Map<string, Layer>();
  function layerFor(id: string): Layer {
    let layer = layers.get(id);
    if (!layer) {
      const element = document.createElement('canvas');
      element.style.cssText = 'position:absolute;pointer-events:none;display:none';
      canvas.append(element);
      layer = { canvas: element, context: element.getContext('2d')!, box: null, shown: false, drawn: null, z: Number.NaN, activeAt: Number.NEGATIVE_INFINITY };
      layers.set(id, layer);
    }
    return layer;
  }
  function stackLayer(layer: Layer, z: number) {
    if (layer.z !== z) { layer.z = z; layer.canvas.style.zIndex = String(z); }
  }
  /** Shows `layer` over `rect` (scene DIP) on whole device pixels, cleared, drawing in scene DIP; null for an unusable rect. */
  function beginLayer(layer: Layer, rect: Rect, dpr: number): CanvasRenderingContext2D | null {
    const box = fitDeviceBox(rect, dpr, layer.box);
    if (!box) return null;
    const element = layer.canvas, style = element.style;
    if (element.width !== box.width || element.height !== box.height) { element.width = box.width; element.height = box.height; }
    style.left = `${box.left / dpr}px`; style.top = `${box.top / dpr}px`; style.width = `${box.width / dpr}px`; style.height = `${box.height / dpr}px`;
    if (!layer.shown) { style.display = 'block'; layer.shown = true; }
    layer.box = box;
    const context = layer.context;
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, box.width, box.height);
    context.setTransform(dpr, 0, 0, dpr, -box.left, -box.top); context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    return context;
  }
  function hideLayer(id: string) {
    const layer = layers.get(id);
    if (!layer || !layer.shown) return;
    layer.canvas.style.display = 'none'; layer.shown = false; layer.drawn = null;
  }
  /** The next render redraws every layer (scene size or device pixel ratio changed). */
  function forceRedraw() { for (const layer of layers.values()) layer.drawn = null; }
  let state: Bootstrap = await adapter.getBootstrap();
  const packs = Object.fromEntries(await Promise.all(PET_IDS.map(async id => [id, await loadPack(id)]))) as Record<PetId, LoadedPack>;
  const engine = new PetEngine(state.preferences, state.scene, Math.random, state.carryOver);
  // A recreated overlay may restore a nap: give each visible kitten's page a moment, so the first
  // frame shows its real pose rather than the idle stopgap (the kitten tracks wait briefly as well).
  const firstPages = engine.snapshot().pets.filter(pet => pet.visible).map(pet => requestPage(packs[pet.id], pet.action).catch(() => {}));
  await Promise.race([Promise.all(firstPages), new Promise(resolve => setTimeout(resolve, FIRST_PAGES_WAIT_MS))]);
  const gesture = new PointerGesture(), sound = new PetSound();
  // Hold-to-pet: the pet commands of a press on a kitten, and when the looping purr plays (spec 6.1).
  const holdPet = new HoldToPet(), purrControl = new PurrControl();
  // `pointer` is the latest real DOM pointer position (the event pointer), recorded at `pointerAt`.
  let pointer = state.cursor, pointerAt = performance.now(), downTarget: Target = null, pointerId: number | null = null, dragOffset: Point = { x: 0, y: 0 }, dragging = false;
  let presented: Presented[] = [], paused = state.hidden || state.paused, last = performance.now(), accumulator = 0, raf = 0, lastSave = 0;
  let lastMode = '';
  // Drawing state: what each kitten shows (topmost first in `presented`), the renderer-side trackers, and frame pacing.
  const presentedById = new Map<PetId, Presented>();
  const tracks = Object.fromEntries(PET_IDS.map(id => [id, new KittenTrack<LoadedPage>(id)])) as Record<PetId, KittenTrack<LoadedPage>>;
  const pairTrack = new PairTrack(), toyVisual = new ToyVisual(), pacer = new FramePacer();
  /** Renderer clock (performance.now() ms), never running backwards between rAF and event-driven renders. */
  let clock = 0;
  /** Stable identities for page objects, so a reloaded page with equal frames still counts as a change. */
  const pageIds = new WeakMap<LoadedPage, number>();
  let nextPageId = 1;
  const pageId = (page: LoadedPage) => { let id = pageIds.get(page); if (id === undefined) { id = nextPageId++; pageIds.set(page, id); } return id; };
  // Cursor feed from the main process (and when its latest message arrived), and the latest input report (resent with every heartbeat).
  let feedInside = false, feedPointer: Point | null = null, feedAt = Number.NEGATIVE_INFINITY, report: { target: Target; capture: boolean } = { target: null, capture: false };
  let presentedToy: Point | null = null, lastInterest = '';
  let framesSinceBeat = 0, lastFrameAt = performance.now();
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined, livenessTimer: ReturnType<typeof setInterval> | undefined;
  // Read-only counters for the native smoke test (cheap values only). `scene` is a compact summary
  // built only when the getter is read; `pageErrors` counts uncaught errors and rejections.
  const counters = { pointerEvents: 0, cursorMessages: 0, frames: 0, fallbackFrames: 0, drags: 0, lostReleases: 0, pageErrors: 0 };
  /** Attention squares in the interest region sent last. */
  let publishedAttention = 0;
  Object.defineProperty(window, '__archieJumi', { configurable: true, get: () => ({ ...counters, lastMode, purring: sound.purring, scene: summarizeScene(engine.snapshot(), engine.attentivePets(), publishedAttention) }) });
  const onPageError = () => { counters.pageErrors++; };
  window.addEventListener('error', onPageError);
  window.addEventListener('unhandledrejection', onPageError);
  const point = (event: PointerEvent | MouseEvent): Point => ({ x: event.clientX, y: event.clientY });
  const eventPoint = (event: PointerEvent): Point => { counters.pointerEvents++; pointerAt = performance.now(); return point(event); };
  function resize() {
    // Native overlay bounds are DIP; a browser preview uses the browser viewport.
    if (!window.desktop) state.scene = { width: innerWidth, height: innerHeight };
    engine.resize(state.scene); forceRedraw();
  }
  /**
   * What is drawn under `p`: the drawn toy, then kittens topmost first through each pose's inverse
   * transform and alpha mask. The kitten reported last (hovered or pressed) also stays hit through its
   * rest shape while a turn or landing squash squeezes it (spriteHit), so a resting cursor keeps it.
   */
  function hit(p: Point | null): Target {
    if (!p || state.preferences.quiet || paused) return null;
    if (presentedToy && Math.hypot(p.x - presentedToy.x, p.y - presentedToy.y) <= TOY_RADIUS) return 'toy';
    const held = report.target;
    for (const item of presented) if (spriteHit(item, p.x, p.y, item.pet.id === held, alphaHit)) return item.pet.id;
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
  /**
   * Tells main where cursor positions matter. `rects`: everything hit() can return for each drawn
   * kitten (spriteHitBounds: the transformed sprite, its untransformed rect and any rest shape) and the
   * drawn toy, inflated; only these count as hover for main's guard. `attention`: a square around each
   * kitten that may notice a resting cursor (reported, never hover). Runs every render (attention can
   * change with nothing redrawn); sent only on change.
   */
  function publishInterest(snap: SceneSnapshot) {
    const curious = state.preferences.curious && !state.preferences.quiet;
    const squares = curious ? engine.attentivePets().flatMap(id => snap.pets.filter(pet => pet.id === id && pet.visible).map(pet => attentionRect(pet, state.scene))) : [];
    const sprites = presented.flatMap(item => spriteHitBounds(item) ?? []);
    const region = buildInterest(sprites, presentedToy, squares);
    const key = interestKey(region);
    if (key === lastInterest) return;
    lastInterest = key;
    publishedAttention = region.attention.length;
    adapter.setInterest({ generation: state.generation, rects: region.rects, attention: region.attention });
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
    // A held pet whose release will never arrive (lost capture, pause, Quiet Mode) ends now.
    const release = holdPet.cancel();
    if (release) command(release);
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
      // A drag after a hold is still a drag: drag-start ends the held pet in the engine.
      if (!dragging) { dragging = true; counters.drags++; holdPet.dragged(); command({ type: 'drag-start', petId: downTarget, point: destination }); }
      command({ type: 'drag', petId: downTarget, point: destination });
    }
    updateInput();
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    pointer = eventPoint(event); downTarget = hit(pointer);
    if (!downTarget) return;
    // The press time lets the frame loop recognize a hold (performance.now(), the clock pollHold uses).
    event.preventDefault(); pointerId = event.pointerId; gesture.begin(pointer, performance.now()); canvas.setPointerCapture(event.pointerId);
    if (downTarget === 'toy') command({ type: 'toy-move', point: pointer, held: true });
    else { const pet = engine.snapshot().pets.find(p => p.id === downTarget)!; dragOffset = { x: pointer.x - pet.x, y: pointer.y - pet.y }; holdPet.press(downTarget); }
    updateInput();
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pointer = eventPoint(event);
    const target = downTarget, result = gesture.end();
    // A click pets for 2 s; the end of a hold releases the held pet; a drag ends in cancelCapture.
    if (target && target !== 'toy') { const next = holdPet.release(result); if (next) command(next); }
    cancelCapture(); savePositions();
  };
  /** Hold-to-pet: a press on a kitten that stays put for HOLD_THRESHOLD_MS becomes a held pet (polled every frame). */
  function pollHold() {
    if (pointerId === null || !downTarget || downTarget === 'toy' || dragging) return;
    const hold = holdPet.poll(gesture.poll(performance.now()));
    if (hold) command(hold);
  }
  /**
   * The looping purr follows the scene's held pet while sound is on and the scene runs; it fades out
   * on release, at the cap, and on hide, pause, Quiet Mode or sound off. A click keeps the one-shot purr.
   */
  function syncPurr(snap: SceneSnapshot) {
    const prefs = state.preferences;
    const wanted = purrLoopWanted({ pets: snap.pets, sound: prefs.sound, quiet: prefs.quiet, running: !paused && !state.hidden });
    const change = purrControl.update(wanted, sound.purring);
    if (change === 'start') sound.startPurrLoop(prefs.volume);
    else if (change === 'stop') sound.stopPurrLoop();
  }
  const onContext = (event: MouseEvent) => {
    event.preventDefault();
    if (!kittenMenuWanted(event, pointerId !== null)) return;
    const target = hit(point(event));
    if (target && target !== 'toy') adapter.showPetMenu(target);
  };
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', cancelCapture); canvas.addEventListener('lostpointercapture', cancelCapture);
  canvas.addEventListener('pointerleave', () => { if (pointerId === null) { pointer = null; updateInput(); } });
  canvas.addEventListener('contextmenu', onContext);
  /** Settings for one drawn frame. `calm` (reduced motion or Quiet Mode) means no procedural motion, tweens or particles. */
  interface FrameContext { time: number; now: number; dpr: number; reduced: boolean; calm: boolean; ambientDue: boolean }
  /** What drawing one kitten reported: its placement this frame, and whether it needs display-rate or ambient frames. */
  interface KittenResult { placement: Placement; facing: Facing; fast: boolean; ambient: boolean }
  /** Draws (when its keys changed) one visible kitten on its layer and its effects on the layer just above it. */
  function drawKitten(pet: PetState, snap: SceneSnapshot, rank: number, f: FrameContext): KittenResult | null {
    const track = tracks[pet.id], pack = packs[pet.id], manifest = pack.manifest;
    const ready = drawablePage(pack, pet.action);
    track.observe({ pet, time: f.time, calm: f.calm, pair: snap.pair, ready, fallback: drawablePage(pack, 'idle'), isOpen: page => !page.closed });
    const page = track.page, clip = track.clip;
    if (!page || !clip) return null;
    const poseInput: PoseInput = {
      pet, time: f.time, reducedMotion: false, velocityX: track.velocityX,
      facingChange: track.facingChange, actionChange: track.change, breathPhase: track.breathPhase,
    };
    const pose = f.calm ? identityPose(pet.facing) : poseFor(poseInput);
    // Walk and trot step with the ground speed; other clips run on actionTime. While the next page loads, the shown frame holds.
    if (ready) track.seconds = f.reduced ? 0 : clip === pet.action ? clipSeconds(pet, clipDurationMs(manifest, clip, pose.drawFacing)) : pet.actionTime;
    const frame = animationFrame(manifest, clip, pose.drawFacing, track.seconds);
    const placement = spritePlacement(pet, manifest, pose);
    // A crossfade (seated stills only; never calm, never across a turn): outgoing at 1 − t, incoming at t.
    const fade = track.fade({ time: f.time, drawFacing: pose.drawFacing, calm: f.calm, isOpen: candidate => !candidate.closed });
    const z = KITTEN_Z + rank * 2;
    // The groom tilt is slow periodic motion: it counts as ambient (its own cadence), not as an active change.
    const posed = poseKey(pose, placement.height * f.dpr, { ambientRotation: pet.action === 'groom' && !pose.tweening }), split = posed.lastIndexOf('|');
    const keys: LayerKeys = {
      active: [f.dpr, pageId(page), frameKey(frame), quantize(placement.anchorX, 0.25), quantize(placement.anchorY, 0.25), quantize(placement.width, 0.25), posed.slice(0, split),
        fade ? `${pageId(fade.outgoing.page)}:${frameKey(fade.outgoing.frame)}:${quantize(fade.t, 1 / 32)}` : ''].join(';'),
      ambient: posed.slice(split + 1),
    };
    const layer = layerFor(pet.id);
    stackLayer(layer, z);
    const change = layerChange(layer.drawn, keys);
    let ambient = false;
    if (change === 'active' || (change === 'ambient' && (f.ambientDue || pose.tweening))) {
      const context = beginLayer(layer, kittenLayerRect(placement, pet.size), f.dpr);
      if (context) {
        if (fade) {
          // A true dissolve on the cleared layer: the premultiplied frames sum, so overlaps stay opaque.
          drawSprite(context, fade.outgoing.page, fade.outgoing.frame, placement, 1 - fade.t);
          drawSprite(context, page, frame, placement, fade.t, 'lighter');
        } else drawSprite(context, page, frame, placement);
        // Under the sprite, exactly as if drawn first, and never summed into a dissolve.
        drawShadow(context, shadowEllipse(placement), 'destination-over');
        layer.drawn = keys;
        if (change === 'active') layer.activeAt = f.now;
        track.drawn = { page, frame, facing: pose.drawFacing };
        // Hit testing follows the more opaque frame of a crossfade.
        const tested = fade && fade.t < 0.5 ? fade.outgoing : { page, frame };
        presentedById.set(pet.id, { pet, page: tested.page, frame: tested.frame, placement, rest: null, z });
        ambient = change === 'ambient' && !pose.tweening;
      }
    }
    const shown = presentedById.get(pet.id);
    if (shown) {
      shown.z = z;
      // While a turn or landing squash runs, the hovered or pressed kitten also keeps its rest shape (spriteHit).
      shown.rest = !f.calm && squeezed(poseInput) ? restPlacement(shown.placement) : null;
    }

    const fx = kittenFx({
      pet, rect: spriteRect(placement), anchor: { x: placement.anchorX, y: placement.anchorY }, time: f.time, calm: f.calm,
      actionSince: track.actionSince, landedAt: track.landedAt, treat: snap.treats.find(treat => treat.petId === pet.id) ?? null, footOffset: footOffset(manifest, pet.size),
    });
    const fxId = `${pet.id}:fx`;
    const fxBounds = unionRects(particleBounds(fx.particles), fx.treat ? treatBounds(fx.treat) : null);
    if (!fxBounds) hideLayer(fxId);
    else {
      const fxLayer = layerFor(fxId), fxKeys = kittenFxKeys(fx);
      fxKeys.active = `${f.dpr}|${fxKeys.active}`;
      stackLayer(fxLayer, z + 1);
      const fxChange = layerChange(fxLayer.drawn, fxKeys);
      if (fxChange === 'active' || (fxChange === 'ambient' && f.ambientDue)) {
        const context = beginLayer(fxLayer, inflateRect(fxBounds, FX_PAD), f.dpr);
        if (context) {
          if (fx.treat) drawTreat(context, fx.treat);
          drawParticles(context, fx.particles);
          fxLayer.drawn = fxKeys;
          if (fxChange === 'active') fxLayer.activeAt = f.now;
          ambient ||= fxChange === 'ambient';
        }
      }
    }
    return { placement, facing: pose.drawFacing, fast: pose.tweening || fx.dusting || fade !== null, ambient };
  }
  /** Seconds since a kitten's layers (sprite or effects) last drew an active change; 0 before its first draw. */
  function stillSeconds(id: PetId, now: number): number {
    const at = Math.max(layers.get(id)?.activeAt ?? Number.NEGATIVE_INFINITY, layers.get(`${id}:fx`)?.activeAt ?? Number.NEGATIVE_INFINITY);
    return Number.isFinite(at) ? Math.max(0, now - at) / 1000 : 0;
  }
  /** The nose-touch heart puff (I8), on its own layer above both kittens. Returns whether it is running. */
  function drawPairEffects(snap: SceneSnapshot, placed: Map<PetId, { placement: Placement; facing: Facing }>, f: FrameContext): boolean {
    if (pairTrack.observe(snap.pair, f.time)) {
      const archie = placed.get('archie'), jumi = placed.get('jumi');
      pairTrack.contact = archie && jumi ? noseContact(archie, jumi) : null;
    }
    const contact = pairTrack.contact, since = pairTrack.contactAt === null ? -1 : f.time - pairTrack.contactAt;
    const puff = contact ? heartPuff(contact.x, contact.y, since, f.calm).filter(particle => particle.alpha > 0) : [];
    const bounds = particleBounds(puff);
    if (!bounds) { hideLayer('pair:fx'); return false; }
    const layer = layerFor('pair:fx'), keys = { active: `${f.dpr}|${particlesKey(puff)}`, ambient: '' };
    stackLayer(layer, PAIR_FX_Z);
    if (layerChange(layer.drawn, keys) !== 'none') {
      const context = beginLayer(layer, inflateRect(bounds, FX_PAD), f.dpr);
      if (context) { drawParticles(context, puff); layer.drawn = keys; }
    }
    return true;
  }
  /** The yarn toy: rolling stripes, trailing thread, release bounce. Returns whether a renderer-clock effect is running. */
  function drawToyLayer(snap: SceneSnapshot, f: FrameContext): boolean {
    const view = toyVisual.observe(snap.toy, f.time, f.calm);
    if (!view) { hideLayer('toy'); presentedToy = null; return false; }
    const layer = layerFor('toy');
    const keys = { active: [f.dpr, quantize(view.x, 0.25), quantize(view.y, 0.25), quantize(view.angle * 180 / Math.PI, 0.5), ...view.thread.flatMap(point => [quantize(point.x, 0.5), quantize(point.y, 0.5)])].join(','), ambient: '' };
    stackLayer(layer, TOY_Z);
    if (layerChange(layer.drawn, keys) !== 'none') {
      const context = beginLayer(layer, toyBounds(view), f.dpr);
      if (context) { drawToy(context, view); layer.drawn = keys; presentedToy = { x: view.x, y: view.y }; }
    }
    return view.bouncing;
  }
  /**
   * Draws whatever changed since the previous frame (spec 5.1, 5.5, 5.6): each layer is redrawn only
   * when its quantized key changes, ambient-only changes at the scene's ambient cadence (all on the
   * same frames: the groom tilt 12 Hz, awake breathing 6 Hz, a nap 4 Hz, a long still nap 3 Hz);
   * reports to the pacer whether the next frames must render at display rate.
   */
  function drawScene(snap: SceneSnapshot, now: number) {
    const reduced = state.preferences.reducedMotion;
    const visible = snap.pets.filter(pet => pet.visible).sort((a, b) => a.y - b.y || PET_IDS.indexOf(a.id) - PET_IDS.indexOf(b.id));
    const ambientMs = sceneAmbientIntervalMs(visible.map(pet => ({ action: pet.action, stillSeconds: stillSeconds(pet.id, now) })));
    const f: FrameContext = { time: now / 1000, now, dpr: devicePixelRatio || 1, reduced, calm: reduced || state.preferences.quiet, ambientDue: pacer.ambientDue(now, ambientMs) };
    for (const id of PET_IDS) {
      if (visible.some(pet => pet.id === id)) continue;
      tracks[id].reset(); hideLayer(id); hideLayer(`${id}:fx`); presentedById.delete(id);
    }
    let fast = false, ambient = false;
    const placed = new Map<PetId, { placement: Placement; facing: Facing }>();
    visible.forEach((pet, rank) => {
      const result = drawKitten(pet, snap, rank, f);
      if (!result) return;
      placed.set(pet.id, result);
      fast ||= result.fast; ambient ||= result.ambient;
    });
    if (drawPairEffects(snap, placed, f)) fast = true;
    if (drawToyLayer(snap, f)) fast = true;
    presented = [...presentedById.values()].sort((a, b) => b.z - a.z);
    if (ambient) pacer.ambientDrawn(now);
    pacer.rendered(now, fast);
  }
  function render(now = performance.now()) {
    canvas.style.visibility = state.hidden ? 'hidden' : 'visible';
    clock = Math.max(clock, now);
    const snap = engine.snapshot();
    syncPurr(snap);
    for (const pet of snap.pets) if (pet.visible) void requestPage(packs[pet.id], pet.action).catch(() => {});
    // Nothing is drawn while paused or hidden (zero sprite draws); hit() answers null meanwhile.
    if (!paused) drawScene(snap, clock);
    publishInterest(snap); updateInput();
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
    pollHold();
    // Cursor curiosity sees the trusted hover pointer (feed or fresh event; DOM events in the browser preview), null when none.
    engine.observeCursor(trustedPointer());
    while (accumulator >= 1 / 30) { engine.step(1 / 30); accumulator -= 1 / 30; }
    clock = Math.max(clock, now);
    if (pacer.due(clock)) render(clock);
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
    paused = false; last = performance.now(); accumulator = 0; lastFrameAt = last; pacer.reset();
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
    else if (next.preferences.volume !== old.preferences.volume) sound.setPurrVolume(next.preferences.volume);
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
  return () => { pause(); clearInterval(heartbeat); offState(); offCommands(); offLifecycle(); offCursor(); delete (window as unknown as Record<string, unknown>).__archieJumi;
    window.removeEventListener('error', onPageError); window.removeEventListener('unhandledrejection', onPageError); window.removeEventListener('resize', resize); for (const pack of Object.values(packs)) for (const page of pack.cache.values()) closePage(page); canvas.remove(); };
}
