/**
 * Canvas drawing for the overlay's shadows, effects, treats and the yarn toy. Every routine draws in
 * scene DIP on a context the overlay has already positioned; none of them reads the DOM. Particles
 * follow the conventions documented in src/core/effects.ts.
 */
import { HEART_PATH_WIDTH, type Particle } from '../core/effects';
import type { Point, Rect } from '../shared/types';
import { TREAT_HEIGHT, TREAT_WIDTH, type TreatGlyph } from './scene-fx';
import { SHADOW_COLOR, type Ellipse } from './sprite';
import { BALL_RADIUS, type ToyView } from './toy-visual';

/** The 1.0.2 colours, plus the new effects. */
export const HEART_COLOR = '#d992a0';
export const Z_COLOR = '#827da6';
export const TREAT_COLOR = '#db9c6c';
export const CRUMB_COLOR = '#c48a5a';
const DUST_RGB = '184, 173, 159', PUFF_RGB = '244, 194, 207';
/** A treat's ground shadow: the kitten shadow's colour, a little stronger, fading while the treat is high. */
const TREAT_SHADOW_COLOR = '#302f3d', TREAT_SHADOW_ALPHA = 0.1;
/** The z glyph is drawn at this font size and scaled, so growing z's never change the font string. */
const Z_FONT_PX = 15;
const Z_FONT = `600 ${Z_FONT_PX}px Segoe UI`;
const THREAD_COLOR = '#b396bd', BALL_COLOR = '#c4a4c8', STRIPE_COLOR = '#9b7fa5';
/** The toy's thread is stroked this wide; its bounds include half of it plus antialiasing. */
const THREAD_WIDTH = 2;

/**
 * The ground shadow. The overlay draws it after the sprite with 'destination-over' (it lands under
 * what is drawn, exactly as if drawn first), so a crossfade's 'lighter' dissolve never sums it into the sprite.
 */
export function drawShadow(context: CanvasRenderingContext2D, shadow: Ellipse, composite: GlobalCompositeOperation = 'source-over'): void {
  if (!(shadow.rx > 0 && shadow.ry > 0 && shadow.alpha > 0)) return;
  context.save();
  if (composite !== 'source-over') context.globalCompositeOperation = composite;
  context.globalAlpha = Math.min(1, shadow.alpha);
  context.fillStyle = SHADOW_COLOR;
  context.beginPath();
  context.ellipse(shadow.x, shadow.y, shadow.rx, shadow.ry, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/** The 1.0.2 heart path around its origin (it spans about ±9.6 × −12.2..4). */
function heartPath(context: CanvasRenderingContext2D): void {
  context.beginPath();
  context.moveTo(0, 4);
  context.bezierCurveTo(-16, -6, -9, -17, 0, -10);
  context.bezierCurveTo(9, -17, 16, -6, 0, 4);
}

function softDot(context: CanvasRenderingContext2D, radius: number, rgb: string): void {
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radius);
  gradient.addColorStop(0, `rgba(${rgb}, 1)`);
  gradient.addColorStop(0.55, `rgba(${rgb}, 0.6)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.fill();
}

/** Draws particles in order; fully transparent ones are skipped. */
export function drawParticles(context: CanvasRenderingContext2D, particles: readonly Particle[]): void {
  for (const particle of particles) {
    if (!(particle.alpha > 0) || !(particle.size > 0)) continue;
    context.save();
    context.globalAlpha = Math.min(1, particle.alpha);
    context.translate(particle.x, particle.y);
    if (particle.rotation) context.rotate(particle.rotation);
    switch (particle.kind) {
      case 'heart': {
        const scale = particle.size / HEART_PATH_WIDTH;
        context.scale(scale, scale);
        context.fillStyle = HEART_COLOR;
        heartPath(context);
        context.fill();
        break;
      }
      case 'z': {
        const scale = particle.size / Z_FONT_PX;
        context.scale(scale, scale);
        context.fillStyle = Z_COLOR;
        context.font = Z_FONT;
        context.fillText('z', 0, 0);
        break;
      }
      case 'dust':
        softDot(context, particle.size / 2, DUST_RGB);
        break;
      case 'puff':
        softDot(context, particle.size / 2, PUFF_RGB);
        break;
      case 'crumb':
        context.fillStyle = CRUMB_COLOR;
        context.beginPath();
        context.roundRect(-particle.size / 2, -particle.size * 0.4, particle.size, particle.size * 0.8, particle.size * 0.3);
        context.fill();
        break;
    }
    context.restore();
  }
}

/** A treat: the 1.0.2 rounded rect, resting on its ground line or `z` above it, over a small ground shadow. */
export function drawTreat(context: CanvasRenderingContext2D, treat: TreatGlyph): void {
  const width = TREAT_WIDTH * treat.scale, height = TREAT_HEIGHT * treat.scale;
  context.save();
  context.globalAlpha = TREAT_SHADOW_ALPHA / (1 + treat.z / 20);
  context.fillStyle = TREAT_SHADOW_COLOR;
  context.beginPath();
  context.ellipse(treat.x, treat.groundY, width / 2, 2 * treat.scale, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
  context.fillStyle = TREAT_COLOR;
  context.beginPath();
  context.roundRect(treat.x - width / 2, treat.groundY - treat.z - height, width, height, 3 * treat.scale);
  context.fill();
}

/** Scene bounds of the drawn toy: the ball and its thread (with the stroke width), plus antialiasing. */
export function toyBounds(view: ToyView): Rect {
  const points: Point[] = [...view.thread];
  let left = view.x - BALL_RADIUS, right = view.x + BALL_RADIUS, top = view.y - BALL_RADIUS, bottom = view.y + BALL_RADIUS;
  for (const point of points) {
    left = Math.min(left, point.x); right = Math.max(right, point.x);
    top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
  }
  const pad = THREAD_WIDTH + 1;
  return { x: left - pad, y: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 };
}

/** The yarn toy as in 1.0.2: thread, ball and stripes, with the stripes turned by the roll angle. */
export function drawToy(context: CanvasRenderingContext2D, view: ToyView): void {
  const [start, first, second, end] = view.thread;
  context.strokeStyle = THREAD_COLOR;
  context.lineWidth = THREAD_WIDTH;
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.bezierCurveTo(first.x, first.y, second.x, second.y, end.x, end.y);
  context.stroke();
  context.fillStyle = BALL_COLOR;
  context.beginPath();
  context.arc(view.x, view.y, BALL_RADIUS, 0, Math.PI * 2);
  context.fill();
  context.save();
  context.beginPath();
  context.arc(view.x, view.y, BALL_RADIUS - 1, 0, Math.PI * 2);
  context.clip();
  context.translate(view.x, view.y);
  if (view.angle) context.rotate(view.angle);
  context.strokeStyle = STRIPE_COLOR;
  context.lineWidth = 1.2;
  for (let i = -18; i < 25; i += 6) {
    context.beginPath();
    context.ellipse(i * 0.3, 0, 7 + i * 0.3, 21, -0.55, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}
