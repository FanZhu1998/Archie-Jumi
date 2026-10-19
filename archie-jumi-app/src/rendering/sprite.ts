/**
 * Sprite geometry for the overlay (Phase 2 spec 5.1): where a kitten frame is drawn, its ground
 * shadow, the exact drawing transform that `frameUV` (src/core/motion.ts) inverts for hit testing, and
 * the layer box that keeps every pose unclipped. Pure; drawing goes through a minimal context type.
 *
 * Units: scene DIP. A kitten centred at (x, y) has its ground anchor (the manifest anchor, where the
 * paws stand) at `anchorX/anchorY`; poses are applied about that anchor.
 */
import { LEAP_HEIGHT } from '../core/engine';
import { frameUV, placementBounds, type Placement, type Pose } from '../core/motion';
import type { AnimationPack, AtlasFrame, Rect } from '../shared/types';
import { unionRects } from './layer-box';

/** The pack fields that sprite geometry depends on. */
export type PackGeometry = Pick<AnimationPack, 'frameWidth' | 'frameHeight' | 'anchor'>;

/** A kitten's size is this fraction of its drawn frame height (1.0.2 geometry). */
export const SPRITE_FILL = 0.85;
/**
 * Inflation of a kitten layer beyond its untransformed sprite rect on each side, as a fraction of the
 * sprite (spec 5.1 asks for at least 15 %). It covers the carried swing (8° plus its pivot offset),
 * the land squash and the walk lean; the leap apex and the carried shadow get their own allowance.
 */
export const LAYER_INFLATION = 0.2;
/** Extra margin kept around the actual transformed bounds and shadow, DIP. */
export const LAYER_GUARD = 2;
/** The 1.0.2 ground shadow: colour (alpha 0x15), radii as fractions of the sprite rect, centre 0.9 down the rect. */
export const SHADOW_COLOR = '#302f3d15';
export const SHADOW_RX = 0.31, SHADOW_RY = 0.045, SHADOW_CENTER = 0.9;

export function spriteScale(pack: PackGeometry, size: number): number {
  return size / (pack.frameHeight * SPRITE_FILL);
}

/** Distance from a kitten's centre down to its ground line, DIP (spec 1: ≈ 0.478 × size for the bundled packs). */
export function footOffset(pack: PackGeometry, size: number): number {
  return (pack.anchor.y / pack.frameHeight - 0.5) * size / SPRITE_FILL;
}

/**
 * Placement of a kitten centred at (x, y) with `pose`: the ground anchor and the frame rect relative
 * to it. With the identity pose the drawn rect is exactly the 1.0.2 sprite rect.
 */
export function spritePlacement(pet: { x: number; y: number; size: number }, pack: PackGeometry, pose: Pose): Placement {
  const scale = spriteScale(pack, pet.size);
  return {
    anchorX: pet.x + (pack.anchor.x - pack.frameWidth / 2) * scale,
    anchorY: pet.y + (pack.anchor.y - pack.frameHeight / 2) * scale,
    offsetX: -pack.anchor.x * scale,
    offsetY: -pack.anchor.y * scale,
    width: pack.frameWidth * scale,
    height: pack.frameHeight * scale,
    pose,
  };
}

/** The untransformed sprite rect (the 1.0.2 rect), whatever the pose. */
export function spriteRect(placement: Placement): Rect {
  return { x: placement.anchorX + placement.offsetX, y: placement.anchorY + placement.offsetY, width: placement.width, height: placement.height };
}

export interface Ellipse { x: number; y: number; rx: number; ry: number; alpha: number }

/** The ground shadow: the 1.0.2 ellipse, kept on the ground (only shadowDy moves it), scaled and faded by the pose. */
export function shadowEllipse(placement: Placement): Ellipse {
  const rect = spriteRect(placement), pose = placement.pose;
  return {
    x: placement.anchorX,
    y: rect.y + rect.height * SHADOW_CENTER + pose.shadowDy,
    rx: rect.width * SHADOW_RX * pose.shadowScale,
    ry: rect.height * SHADOW_RY * pose.shadowScale,
    alpha: pose.shadowAlpha,
  };
}

/**
 * Layer box for a kitten sprite and its shadow: the untransformed sprite rect inflated by
 * LAYER_INFLATION on every side, extended upward by the leap apex (LEAP_HEIGHT × size), so the box size
 * depends only on the kitten's size and its canvas is not reallocated as the pose changes. It is
 * united with the actual transformed bounds and shadow (plus LAYER_GUARD), so nothing ever clips.
 */
export function kittenLayerRect(placement: Placement, size: number): Rect {
  const rect = spriteRect(placement);
  const padX = rect.width * LAYER_INFLATION, padY = rect.height * LAYER_INFLATION;
  let left = rect.x - padX, right = rect.x + rect.width + padX;
  let top = rect.y - padY - LEAP_HEIGHT * size, bottom = rect.y + rect.height + padY;
  const bounds = placementBounds(placement), shadow = shadowEllipse(placement);
  if ([bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    left = Math.min(left, bounds.x - LAYER_GUARD);
    top = Math.min(top, bounds.y - LAYER_GUARD);
    right = Math.max(right, bounds.x + bounds.width + LAYER_GUARD);
    bottom = Math.max(bottom, bounds.y + bounds.height + LAYER_GUARD);
  }
  if ([shadow.x, shadow.y, shadow.rx, shadow.ry].every(Number.isFinite)) {
    left = Math.min(left, shadow.x - shadow.rx - LAYER_GUARD);
    right = Math.max(right, shadow.x + shadow.rx + LAYER_GUARD);
    bottom = Math.max(bottom, shadow.y + shadow.ry + LAYER_GUARD);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The part of CanvasRenderingContext2D that sprite drawing uses. */
export interface SpriteContext {
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  drawImage(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

/** An image page: the frame's atlas coordinates minus the page offset address the page bitmap. */
export interface SpritePage { image: CanvasImageSource; offsetX: number; offsetY: number }

/**
 * Draws `frame` with the documented transform: translate to the ground anchor plus (dx, dy), rotate,
 * scale, then the frame rect relative to the anchor. `frameUV` inverts exactly this. `opacity`
 * multiplies the pose alpha and `composite` is the compositing operation: a crossfade draws the
 * outgoing frame at 1 − t, then the incoming one at t with 'lighter', which on a cleared layer sums
 * the premultiplied frames into a true dissolve (overlaps stay opaque, each silhouette fades on its own).
 */
export function drawSprite(context: SpriteContext, page: SpritePage, frame: AtlasFrame, placement: Placement, opacity = 1, composite: GlobalCompositeOperation = 'source-over'): void {
  const pose = placement.pose;
  context.save();
  context.globalAlpha = Math.max(0, Math.min(1, opacity * pose.alpha));
  if (composite !== 'source-over') context.globalCompositeOperation = composite;
  context.translate(placement.anchorX + pose.dx, placement.anchorY + pose.dy);
  context.rotate(pose.rotation);
  context.scale(pose.scaleX, pose.scaleY);
  context.drawImage(page.image, frame.x - page.offsetX, frame.y - page.offsetY, frame.w, frame.h, placement.offsetX, placement.offsetY, placement.width, placement.height);
  context.restore();
}

/**
 * A drawn kitten as hit testing sees it: the frame to test (during a crossfade the more opaque of the
 * two), its placement, and while a turn or landing squash squeezes it (`squeezed` in
 * src/core/motion.ts) its rest placement (`restPlacement`), else null.
 */
export interface HitSprite<P> { page: P; frame: AtlasFrame; placement: Placement; rest: Placement | null }

/**
 * Whether scene point (x, y) hits the drawn kitten: exactly through its placement and the frame's
 * alpha mask. A kitten that is already the hover or press target (`held`) also stays hit through its
 * rest placement while a squeeze runs (at most TURN_MS or LAND_SQUASH_MS), so a turn or landing under
 * a resting cursor never makes the overlay click-through for a few frames. A kitten not yet hovered is
 * only ever hit where it is drawn.
 */
export function spriteHit<P>(sprite: HitSprite<P>, x: number, y: number, held: boolean, alphaHit: (page: P, frame: AtlasFrame, u: number, v: number) => boolean): boolean {
  const uv = frameUV(x, y, sprite.placement);
  if (uv && alphaHit(sprite.page, sprite.frame, uv.u, uv.v)) return true;
  if (!held || !sprite.rest) return false;
  const rest = frameUV(x, y, sprite.rest);
  return rest !== null && alphaHit(sprite.page, sprite.frame, rest.u, rest.v);
}

/**
 * Scene bounds of everything `spriteHit` can return for a drawn kitten: the transformed sprite, its
 * untransformed rect (so a squeezed sprite does not shrink the interest region for a few frames) and
 * the rest placement while one is set. Null for non-finite input.
 */
export function spriteHitBounds(sprite: Pick<HitSprite<unknown>, 'placement' | 'rest'>): Rect | null {
  return unionRects(placementBounds(sprite.placement), spriteRect(sprite.placement), sprite.rest ? placementBounds(sprite.rest) : null);
}
