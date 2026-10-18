/**
 * LEGACY cartoon/vector artwork retained for reference, not the default pipeline.
 *
 * node scripts/generate-art-legacy-vector.mjs --replace-current-art [--frame-size=512]
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--replace-current-art')) {
  throw new Error('Legacy vector generator is disabled by default. Use npm run art for realistic sprites; --replace-current-art explicitly restores the old cartoon packs.');
}

const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); }
catch {
  // Codex's bundled image runtime is an authoring fallback, never an app dependency.
  sharp = require(resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sizeArgument = process.argv.find((value) => value.startsWith('--frame-size='));
const frameSize = Number(sizeArgument?.split('=')[1] ?? 512);
if (!Number.isInteger(frameSize) || frameSize < 128 || frameSize > 512) {
  throw new Error('--frame-size must be a whole number from 128 to 512.');
}
const unit = frameSize / 256;
const actions = ['idle', 'walk', 'trot', 'sit', 'groom', 'sleep', 'wake', 'pet', 'carried', 'land', 'pounce', 'eat', 'nose_touch'];
const directions = ['right', 'left'];
const frameCount = 4;
const columns = 8;
const rows = 13;
const palettes = {
  archie: {
    name: 'Archie', fur: '#8b9997', furLight: '#bdc7bf', furShade: '#667a79',
    outline: '#405a59', stripe: '#506967', white: '#fff9ec', whiteShade: '#e5ebdc',
    iris: '#7caaa1', irisDark: '#375d61', ear: '#d4a4a3', earLight: '#efd1c2',
    nose: '#cf8f95', blush: '#edb3aa', paw: '#e7b3ae',
  },
  jumi: {
    name: 'Jumi', fur: '#edba74', furLight: '#ffe0a7', furShade: '#d79453',
    outline: '#906248', stripe: '#bc7f45', white: '#fff2d4', whiteShade: '#f2dbb5',
    iris: '#85a7ac', irisDark: '#426573', ear: '#e4aa94', earLight: '#f7d2b4',
    nose: '#d58d8c', blush: '#eea49a', paw: '#e6a99d',
  },
};

const n = (value) => Number(value.toFixed(3));
const fill = (d, color, extra = '') => `<path d="${d}" fill="${color}" ${extra}/>`;
const line = (d, color, width = 2, extra = '') => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const ellipse = (x, y, rx, ry, color, extra = '') => `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" fill="${color}" ${extra}/>`;
const outlined = (d, color, p, width = 2.5, extra = '') => fill(d, color, `stroke="${p.outline}" stroke-opacity=".72" stroke-width="${width}" stroke-linejoin="round" ${extra}`);

function definitions(p) {
  return `<defs>
    <linearGradient id="fur" x1=".25" y1="0" x2=".75" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="${p.furLight}"/><stop offset=".5" stop-color="${p.fur}"/><stop offset="1" stop-color="${p.furShade}"/></linearGradient>
    <linearGradient id="face" x1=".35" y1=".1" x2=".7" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="${p.furLight}"/><stop offset=".67" stop-color="${p.fur}"/><stop offset="1" stop-color="${p.furShade}"/></linearGradient>
    <linearGradient id="white" x1="0" y1="0" x2=".7" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="${p.white}"/><stop offset="1" stop-color="${p.whiteShade}"/></linearGradient>
    <linearGradient id="ear" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="${p.earLight}"/><stop offset="1" stop-color="${p.ear}"/></linearGradient>
    <radialGradient id="iris" cx=".35" cy=".25" r=".8"><stop stop-color="${p.iris}"/><stop offset="1" stop-color="${p.irisDark}"/></radialGradient>
    <radialGradient id="cheek"><stop stop-color="${p.blush}" stop-opacity=".55"/><stop offset="1" stop-color="${p.blush}" stop-opacity="0"/></radialGradient>
  </defs>`;
}

function sparkle(x, y, s, color = '#e8bc6c', opacity = 1) {
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)})" opacity="${opacity}">${fill('M0 -7 Q1 -1 7 0 Q1 1 0 7 Q-1 1 -7 0 Q-1 -1 0 -7Z', color)}</g>`;
}

function heart(x, y, s, opacity = 1) {
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s)})" opacity="${n(opacity)}">${fill('M0 5 C-18 -7 -11 -18 -3 -13 C-1 -12 0 -10 0 -9 C4 -18 15 -14 12 -6 C10 -1 4 3 0 5Z', '#e8a49d')}</g>`;
}

function paw(p, x, y, rotation = 0, white = true, scale = 1, pads = false) {
  const padArt = pads ? `${ellipse(0, 0, 5, 4, p.paw)}${[-6, 0, 6].map((v, i) => ellipse(v, -6 - (i === 1 ? 2 : 0), 2.4, 2.8, p.paw)).join('')}` :
    `${line('M-4 4 L-4 8 M3 4 L3 8', p.outline, 1.15, 'opacity=".35"')}`;
  return `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(rotation)}) scale(${scale})">${outlined('M-12 -6 C-12 -14 -6 -16 1 -15 C11 -14 15 -9 15 0 C15 8 9 12 0 12 C-10 12 -15 7 -15 1 C-15 -2 -14 -4 -12 -6Z', white ? 'url(#white)' : 'url(#fur)', p, 2)}${padArt}</g>`;
}

function tail(p, wave, posture) {
  let d;
  if (posture === 'sleep') d = `M82 204 C36 218 24 190 35 166 C42 151 58 155 55 168 C43 184 51 198 79 188`;
  else if (posture === 'carried') d = `M107 174 C81 204 61 215 42 ${n(196 + wave * 5)} C31 183 38 174 45 179 C51 190 64 196 85 171`;
  else d = `M99 190 C55 201 38 173 48 145 C55 125 43 ${n(100 + wave * 5)} 29 ${n(109 + wave * 6)} C15 120 21 ${n(134 + wave * 3)} 31 134 C37 133 39 129 40 124`;
  const base = `<path d="${d}" fill="none" stroke="${p.outline}" stroke-opacity=".7" stroke-width="21" stroke-linecap="round"/>`;
  const color = `<path d="${d}" fill="none" stroke="${p.furShade}" stroke-width="17" stroke-linecap="round"/>`;
  const upper = `<path d="${d}" fill="none" stroke="${p.fur}" stroke-width="11" stroke-linecap="round"/>`;
  const stripeArt = posture === 'sleep' ?
    `${line('M29 183 Q37 187 43 185', p.stripe, 7)}${line('M31 199 Q38 198 44 195', p.stripe, 6)}${line('M48 211 L54 199', p.stripe, 7)}` :
    posture === 'carried' ? `${line('M61 202 L67 192 M80 193 L86 184', p.stripe, 6)}` :
      `${line('M41 160 L53 162 M42 178 L55 175 M57 192 L65 181', p.stripe, 7, 'opacity=".72"')}`;
  return `<g>${base}${color}${upper}${stripeArt}</g>`;
}

function ear(p, side, twitch, whiteTuft) {
  const left = side === 'left';
  const transform = left ? `translate(-43 -37) rotate(${-10 + twitch})` : `translate(43 -38) rotate(${8 - twitch / 2})`;
  return `<g transform="${transform}">
    ${outlined('M-20 16 C-24 -3 -24 -23 -18 -47 C-14 -57 -9 -52 -2 -44 C9 -34 20 -12 22 11 C10 26 -4 28 -20 16Z', 'url(#fur)', p)}
    ${fill('M-13 6 C-17 -8 -17 -28 -13 -39 C-7 -36 5 -14 11 6 Q0 1 -13 6Z', 'url(#ear)')}
    ${line('M-13 -33 Q-10 -20 -3 -10', p.earLight, 2, 'opacity=".8"')}
    ${fill('M-17 11 L-11 2 L-8 8 L-3 0 L0 9 L8 3 L10 13Z', whiteTuft ? p.white : p.furLight, 'opacity=".9"')}
  </g>`;
}

function eye(p, x, y, near, expression, blink, gaze = 0) {
  const rx = near ? 14.7 : 13.1;
  const ry = near ? 18.2 : 16.7;
  if (expression === 'happy' || expression === 'sleep' || blink > .85) {
    const curve = expression === 'happy' ? -7 : 6;
    return `${line(`M${x - rx} ${y + 1} Q${x} ${y + curve} ${x + rx} ${y}`, p.outline, 3.4)}${line(`M${x - rx - 1} ${y} L${x - rx - 4} ${y - 2}`, p.outline, 2)}`;
  }
  const sy = Math.max(.18, 1 - blink);
  return `<g transform="translate(${x} ${y}) scale(1 ${n(sy)})">
    ${ellipse(0, 0, rx + 1.8, ry + 1.8, p.outline, 'opacity=".8"')}
    ${ellipse(.5, .7, rx, ry, '#fffaf0')}
    ${ellipse(2 + gaze, 1, rx - 2.2, ry - 1.1, 'url(#iris)')}
    ${ellipse(2.7 + gaze, 0, rx - 5, ry - 3, '#243f46')}
    ${ellipse(-2.3 + gaze, -7.7, 4.7, 5.7, '#fffdf4')}
    ${ellipse(7.4 + gaze, 8.5, 2.1, 2.6, '#f5ffec', 'opacity=".85"')}
    ${line(`M${-rx} -3 Q-11 ${-ry - 8} 1 ${-ry - 1} Q10 ${-ry + 1} ${rx} -5`, p.outline, 2.7)}
  </g>`;
}

function head(p, id, config = {}) {
  const { expression = 'open', blink = 0, twitch = 0, gaze = 0, facing = 'right', mouth = 'smile', whisker = 0 } = config;
  const archie = id === 'archie';
  const headD = 'M-60 -19 C-63 -36 -49 -56 -31 -61 L-28 -66 L-19 -62 L-11 -68 L-4 -63 L5 -67 L11 -62 C34 -64 54 -48 61 -29 L68 -28 L63 -18 L70 -14 L64 -7 C72 6 65 27 53 35 L57 41 L45 41 L47 47 L34 45 C14 58 -12 58 -33 47 L-46 50 L-44 43 L-55 43 L-52 36 C-66 26 -71 11 -65 0 L-71 -5 L-63 -12 L-69 -19Z';
  let marking = '';
  if (archie) {
    const bias = facing === 'right' ? 0 : 3;
    marking += fill(`M${-1 + bias} -60 C-7 -43 -2 -28 -13 -14 C-21 -4 -23 4 -32 9 C-47 12 -53 27 -42 38 C-29 52 11 56 35 45 C49 39 56 20 41 11 C27 3 19 -7 17 -20 C14 -37 12 -49 8 -61Z`, 'url(#white)');
    marking += fill(facing === 'right' ? 'M-57 -26 Q-37 -17 -36 -2 Q-51 -9 -61 -9Z' : 'M-58 -24 Q-36 -17 -34 0 Q-50 -7 -61 -7Z', p.stripe, 'opacity=".64"');
    marking += fill('M43 -35 Q31 -23 32 -13 Q46 -19 52 -27Z', p.stripe, 'opacity=".7"');
    marking += fill('M-24 -56 Q-12 -35 -17 -23 Q-27 -35 -31 -50Z M26 -54 Q19 -36 24 -25 Q32 -40 35 -47Z', p.stripe, 'opacity=".65"');
  } else {
    marking += fill('M-28 13 C-43 13 -48 30 -35 41 C-20 52 11 54 33 45 C47 39 50 25 38 18 C24 12 13 17 5 21 C-5 14 -18 11 -28 13Z', 'url(#white)', 'opacity=".95"');
    marking += fill('M-18 -59 Q-12 -45 -16 -30 Q-26 -40 -29 -54Z M0 -63 Q7 -48 4 -35 Q-3 -44 -7 -61Z M24 -58 Q19 -42 22 -30 Q32 -43 35 -53Z', p.stripe, 'opacity=".67"');
    marking += fill('M-60 -20 Q-40 -15 -32 -6 Q-49 -7 -63 -10Z M-62 0 Q-48 0 -38 8 L-60 10Z M54 -25 Q40 -16 36 -8 Q50 -12 61 -17Z M64 -4 Q47 0 41 8 L62 6Z', p.stripe, 'opacity=".66"');
  }
  const near = facing === 'right';
  return `<g>
    ${ear(p, 'left', twitch, archie)}${ear(p, 'right', twitch, archie)}
    ${outlined(headD, 'url(#face)', p, 2.8)}
    ${marking}
    ${line('M-47 -33 Q-41 -40 -32 -42 M31 -43 Q40 -40 45 -32', p.furLight, 2.8, 'opacity=".5"')}
    ${ellipse(-39, 17, 19, 12, 'url(#cheek)')}${ellipse(44, 17, 17, 11, 'url(#cheek)')}
    ${eye(p, -20, -3, !near, expression, blink, gaze)}
    ${eye(p, 27, -4, near, expression, blink, gaze)}
    ${line('M-34 -27 Q-24 -33 -15 -29 M19 -30 Q30 -34 40 -28', p.outline, 2.2, 'opacity=".36"')}
    ${ellipse(-5, 29, 16, 10, p.white, 'opacity=".9"')}${ellipse(20, 29, 16, 10, p.white, 'opacity=".9"')}
    ${outlined('M1 23 C2 19 16 19 18 23 C19 26 12 32 9 32 C6 32 -1 26 1 23Z', p.nose, p, 1.25)}
    ${line('M5 22 Q9 20 13 22', '#ffe0d1', 1.6, 'opacity=".8"')}
    ${line('M9 32 L9 36 M9 36 Q3 43 -4 37 M9 36 Q16 43 22 36', p.outline, 1.8)}
    ${mouth === 'tongue' ? `${fill('M3 39 Q10 44 17 39 Q18 51 10 52 Q3 50 3 39Z', '#e7a3a2')}${line('M10 42 L10 48', p.nose, 1)}` : ''}
    ${mouth === 'open' ? `${ellipse(10, 41, 5, 4, p.outline)}${ellipse(10, 43, 3.4, 1.8, p.nose)}` : ''}
    ${[-9, -16, -10].map((x, i) => ellipse(x, 26 + [0, 5, 8][i], .9, .9, p.outline, 'opacity=".55"')).join('')}
    ${[29, 35, 30].map((x, i) => ellipse(x, 25 + [0, 5, 8][i], .9, .9, p.outline, 'opacity=".55"')).join('')}
    ${line(`M-25 27 Q-47 ${21 + whisker} -68 ${23 + whisker} M-25 32 Q-49 31 -71 36 M-25 37 Q-48 ${43 - whisker} -65 ${48 - whisker}`, p.white, 1.35, 'opacity=".88"')}
    ${line(`M37 27 Q57 ${19 + whisker} 77 ${21 + whisker} M38 32 Q61 29 78 33 M37 37 Q60 ${39 - whisker} 74 ${46 - whisker}`, p.white, 1.35, 'opacity=".88"')}
    ${line('M-40 39 L-45 37 M36 45 L41 42', p.white, 1.4, 'opacity=".7"')}
  </g>`;
}

/** A true profile is needed for contact; a front-facing muzzle cannot meet its
 * partner without overlapping both faces. Nose in 256-unit design space:
 * (221.5, 135), scaled with every other coordinate when exported. */
function profileHead(p, id, config = {}) {
  const { expression = 'open', facing = 'right', twitch = 0 } = config;
  const archie = id === 'archie';
  const silhouette = 'M-48 -20 C-52 -41 -35 -59 -15 -62 L-10 -67 L-2 -63 L5 -67 L12 -62 C30 -61 45 -46 45 -28 C45 -13 47 -3 54 6 C59 10 63 11 64 17 C64 23 59 26 53 27 C52 39 43 47 28 50 C8 57 -14 53 -31 43 L-42 46 L-40 38 L-49 37 L-46 30 C-56 22 -59 8 -53 0 L-59 -5 L-51 -12 L-57 -19Z';
  const blazeBias = facing === 'right' ? 0 : 2;
  const markings = archie ?
    `${fill(`M${15 + blazeBias} -58 C22 -39 21 -23 32 -10 C38 -3 46 4 54 8 C63 13 63 23 53 27 C52 39 43 47 28 50 C15 53 5 51 -2 46 C13 40 21 33 23 23 C24 11 15 4 19 -10 C23 -28 11 -45 ${15 + blazeBias} -58Z`, 'url(#white)')}
     ${fill('M-39 -41 Q-15 -32 -12 -14 Q-27 -22 -46 -24Z M-50 -11 Q-30 -13 -17 0 Q-34 -3 -51 2Z M-46 12 Q-28 5 -18 15 Q-34 17 -41 23Z M-14 -59 Q-4 -45 -6 -31 Q-17 -42 -23 -54Z', p.stripe, 'opacity=".67"')}` :
    `${fill('M31 9 C38 4 47 5 55 9 C64 13 64 22 54 27 C53 39 42 47 28 50 C14 53 3 49 1 40 C0 30 14 17 31 9Z', 'url(#white)')}
     ${fill('M-32 -53 Q-21 -42 -22 -30 Q-33 -38 -40 -47Z M-13 -61 Q-1 -47 -3 -32 Q-14 -44 -21 -58Z M11 -61 Q21 -47 18 -33 Q9 -45 3 -62Z M-48 -26 Q-27 -22 -17 -10 Q-35 -15 -52 -14Z M-53 -3 Q-30 -7 -18 5 Q-37 2 -51 8Z M-46 15 Q-30 10 -17 18 Q-33 21 -41 27Z', p.stripe, 'opacity=".68"')}`;
  return `<g>
    <g transform="translate(11 2) scale(.9)">${ear(p, 'left', twitch, archie)}</g>
    <g transform="translate(-26 -1)">${ear(p, 'right', twitch, archie)}</g>
    ${outlined(silhouette, 'url(#face)', p, 2.8)}
    ${markings}
    ${line('M-36 -33 Q-29 -41 -19 -43', p.furLight, 2.5, 'opacity=".6"')}
    ${ellipse(24, 22, 22, 13, 'url(#cheek)')}
    ${eye(p, 12, -5, true, expression, 0, 1.2)}
    ${line('M-2 -29 Q10 -35 24 -29', p.outline, 2.2, 'opacity=".4"')}
    ${ellipse(41, 28, 16, 10, p.white, 'opacity=".86"')}
    ${outlined('M56 13 C59 10 66 11 67 15 C68 18 63 23 59 22 C56 20 54 16 56 13Z', p.nose, p, 1.25)}
    ${line('M59 13 L63 13', '#ffe0d1', 1.45, 'opacity=".85"')}
    ${line('M59 22 Q56 28 54 30 Q46 36 38 31', p.outline, 1.8)}
    ${[0, 1, 2].map(i => ellipse(38 + [0, 6, 1][i], 24 + [0, 3, 7][i], .9, .9, p.outline, 'opacity=".5"')).join('')}
    ${line('M38 28 Q55 25 77 25 M38 33 Q58 35 78 40 M35 37 Q53 44 68 49', p.white, 1.35, 'opacity=".88"')}
    ${line('M-33 35 L-38 32 M-26 42 L-32 40', p.white, 1.4, 'opacity=".6"')}
  </g>`;
}

function standingBody(p, id, pose) {
  const { phase, action, bob, facing } = pose;
  const archie = id === 'archie';
  const moving = action === 'walk' || action === 'trot';
  const carry = action === 'carried';
  const crouch = action === 'land' || action === 'pounce';
  const bouncy = action === 'trot' ? 1.3 : 1;
  const step = moving ? Math.sin(phase) * 9 * bouncy : 0;
  const liftA = moving ? Math.max(0, Math.cos(phase)) * 9 : 0;
  const liftB = moving ? Math.max(0, -Math.cos(phase)) * 9 : 0;
  if (moving) {
    const rear = (x, lift, shade = false) => `${outlined(`M${x - 7} 183 Q${x - 15} 202 ${n(x - 8 - step)} ${n(218 - lift)} Q${n(x - step)} ${n(229 - lift)} ${n(x + 10 - step)} ${n(219 - lift)} L${x + 16} 187Z`, shade ? p.furShade : 'url(#fur)', p, 2)}${paw(p, x + 1 - step, 220 - lift, -4, archie, .83)}`;
    const front = (x, lift, shade = false) => `${outlined(`M${x - 10} 178 Q${x - 15} 197 ${n(x - 10 + step)} ${n(218 - lift)} Q${n(x + step)} ${n(227 - lift)} ${n(x + 10 + step)} ${n(219 - lift)} L${x + 12} 177Z`, shade ? p.furShade : 'url(#fur)', p, 2)}${paw(p, x + step, 220 - lift, 3, true, .9)}`;
    return `${rear(96, liftB, true)}${front(149, liftA, true)}
      ${outlined(`M65 ${176 + bob} C67 ${151 + bob} 96 ${144 + bob} 119 ${150 + bob} C146 ${145 + bob} 167 ${156 + bob} 172 ${180 + bob} C176 204 157 217 130 214 C109 218 79 215 68 203 C62 195 60 184 65 ${176 + bob}Z`, 'url(#fur)', p)}
      ${fill(`M73 ${164 + bob} Q93 ${162 + bob} 101 ${177 + bob} Q82 ${172 + bob} 67 ${180 + bob}Z M67 ${187 + bob} Q87 ${178 + bob} 102 ${191 + bob} Q81 ${189 + bob} 70 ${200 + bob}Z M109 ${152 + bob} Q118 ${166 + bob} 113 ${177 + bob} Q104 ${166 + bob} 102 ${152 + bob}Z`, p.stripe, 'opacity=".55"')}
      ${archie ? fill(`M144 ${157 + bob} Q158 ${158 + bob} 168 ${169 + bob} Q178 195 154 210 L140 204 Q149 181 144 ${157 + bob}Z`, 'url(#white)') : ''}
      ${rear(86, liftA)}${front(166, liftB)}`;
  }
  const pelvis = carry ? 166 : 188 + (crouch ? 9 : 0);
  const bodyY = carry ? 157 : 182 + bob + (crouch ? 8 : 0);
  const backLeg = `${outlined(`M95 ${pelvis - 11} Q84 ${pelvis + 5} ${n(87 - step)} ${carry ? 217 : 219 - liftB} Q97 234 ${n(113 - step)} ${carry ? 218 : 222 - liftB} L120 ${pelvis - 7}Z`, 'url(#fur)', p, 2)}${paw(p, 99 - step, (carry ? 222 : 220 - liftB), -5, archie, .91, carry)}`;
  const hind = outlined(`M84 ${bodyY - 31} C58 ${bodyY - 11} 62 217 86 224 C109 233 144 224 154 202 C166 174 144 ${bodyY - 48} 121 ${bodyY - 44} C105 ${bodyY - 42} 93 ${bodyY - 39} 84 ${bodyY - 31}Z`, 'url(#fur)', p);
  const body = outlined(`M117 ${bodyY - 49} C94 ${bodyY - 40} 94 ${bodyY - 6} 103 ${bodyY + 15} C114 ${bodyY + 37} 147 ${bodyY + 39} 163 ${bodyY + 17} C176 ${bodyY - 3} 164 ${bodyY - 40} 143 ${bodyY - 48}Z`, 'url(#fur)', p, 2.4);
  const bib = archie ? fill(`M111 ${bodyY - 38} C122 ${bodyY - 29} 146 ${bodyY - 30} 156 ${bodyY - 38} C162 ${bodyY - 14} 155 ${bodyY + 10} 135 ${bodyY + 17} L132 ${bodyY + 12} L124 ${bodyY + 17} L122 ${bodyY + 10} L115 ${bodyY + 12} C102 ${bodyY - 2} 105 ${bodyY - 22} 111 ${bodyY - 38}Z`, 'url(#white)') :
    fill(`M115 ${bodyY - 35} Q132 ${bodyY - 27} 153 ${bodyY - 37} Q165 ${bodyY - 6} 146 ${bodyY + 10} Q124 ${bodyY + 19} 112 ${bodyY - 7}Z`, p.furLight, 'opacity=".65"');
  const stripes = `${fill(`M75 ${bodyY - 17} Q94 ${bodyY - 21} 103 ${bodyY - 6} Q85 ${bodyY - 10} 70 ${bodyY - 4}Z M72 ${bodyY + 6} Q90 ${bodyY - 1} 102 ${bodyY + 11} Q83 ${bodyY + 8} 74 ${bodyY + 17}Z`, p.stripe, 'opacity=".55"')}${line(`M151 ${bodyY - 16} Q159 ${bodyY - 13} 165 ${bodyY - 8}`, p.stripe, 5, 'opacity=".55"')}`;
  let forelegs;
  if (carry) {
    forelegs = `${outlined('M117 174 Q112 193 117 218 Q124 229 136 216 L141 175Z', 'url(#fur)', p)}${paw(p, 126, 221, 2, true, .95, true)}${outlined('M149 173 Q143 195 150 212 Q159 224 170 211 L169 177Z', 'url(#fur)', p)}${paw(p, 160, 216, -9, true, .95, true)}`;
  } else {
    const xA = 128 + step, xB = 159 - step;
    const yA = 220 - liftA, yB = 220 - liftB;
    forelegs = `${outlined(`M118 ${bodyY - 1} Q110 201 ${n(xA - 11)} ${n(yA)} Q${n(xA)} ${n(yA + 7)} ${n(xA + 11)} ${n(yA)} L140 ${bodyY - 1}Z`, 'url(#fur)', p, 2)}${paw(p, xA, yA, 1, true)}${outlined(`M149 ${bodyY - 2} Q145 201 ${n(xB - 11)} ${n(yB)} Q${n(xB)} ${n(yB + 8)} ${n(xB + 11)} ${n(yB)} L170 ${bodyY - 1}Z`, 'url(#fur)', p, 2)}${paw(p, xB, yB, -4, true)}`;
  }
  if (action === 'groom') {
    forelegs += `<g transform="rotate(${-16 + Math.sin(phase) * 4} 144 171)">${outlined('M148 185 Q136 173 141 148 Q148 135 158 143 Q167 153 164 180Z', 'url(#fur)', p, 2)}${paw(p, 153, 146, -10, true, .85)}</g>`;
  }
  return `${backLeg}${hind}${body}${bib}${stripes}${forelegs}${line(`M86 207 Q89 199 98 199`, p.furLight, 2, 'opacity=".55"')}`;
}

function sleepingBody(p, id, wave) {
  const y = 201 + wave;
  return `${outlined(`M52 ${y} C48 175 79 161 115 168 C140 166 164 180 170 201 C174 219 152 232 116 232 C85 232 56 224 52 ${y}Z`, 'url(#fur)', p)}
    ${fill('M64 183 Q85 178 94 191 L63 196Z M91 173 Q111 176 115 190 L102 196Z M129 177 Q145 184 146 196 L136 201Z', p.stripe, 'opacity=".58"')}
    ${ellipse(127, 222, 39, 10, id === 'archie' ? p.whiteShade : p.furLight)}
    ${paw(p, 154, 222, 7, true, 1.04)}${paw(p, 185, 220, -3, true, 1.08)}`;
}

function frameSvg(id, action, facing, index, { plain = false } = {}) {
  const p = palettes[id];
  const phase = index / frameCount * Math.PI * 2;
  const wave = Math.sin(phase);
  const moving = action === 'walk' || action === 'trot';
  const sleep = action === 'sleep';
  let bob = moving ? Math.abs(wave) * -3 : wave * .8;
  let headX = moving ? 157 : 137;
  let headY = moving ? 120 + bob : 111 + bob;
  let headScale = moving ? .91 : 1;
  let rotation = moving ? -4 : 0;
  let expression = 'open';
  let blink = action === 'idle' && index === 2 ? 1 : 0;
  let mouth = 'smile';
  let verticalOffset = 0;
  if (action === 'sit') { headY = 118 + bob; rotation = -3 + wave * 1.5; }
  if (action === 'pet') {
    expression = 'happy'; rotation = wave * 5; headY = 108 + bob;
  }
  if (action === 'groom') { headX = 145; headY = 126; rotation = 10 + wave * 5; expression = 'happy'; mouth = index % 2 === 0 ? 'tongue' : 'smile'; }
  if (action === 'carried') { headX = 138; headY = 104; headScale = .95; rotation = wave * 3; bob = 0; mouth = 'open'; }
  if (action === 'land') { headY = [136, 146, 128, 114][index]; headScale = [1, 1.04, 1.01, 1][index]; expression = index === 1 ? 'happy' : 'open'; }
  if (action === 'wake') { headY = [145, 129, 114, 111][index]; expression = index < 2 ? 'sleep' : 'open'; mouth = index === 1 ? 'open' : 'smile'; headScale = [.88, .94, 1, 1][index]; }
  if (action === 'eat') { headX = 151; headY = 136 + (index % 2) * 4; rotation = 12; headScale = .92; expression = index % 2 ? 'happy' : 'open'; mouth = index % 2 ? 'tongue' : 'smile'; }
  if (action === 'pounce') {
    headY = [132, 115, 105, 130][index]; headX = [141, 148, 149, 145][index]; headScale = .93;
    rotation = [-7, -9, -7, -1][index]; verticalOffset = [0, -5, -9, 0][index];
    expression = index === 3 ? 'happy' : 'open';
  }
  if (action === 'nose_touch') { headX = [146, 150, 154, 151][index]; headY = 119; rotation = 0; headScale = 1; expression = index > 0 ? 'happy' : 'open'; }
  let art;
  if (sleep) {
    art = `${tail(p, wave, 'sleep')}${sleepingBody(p, id, wave * .55)}<g transform="translate(172 ${n(182 + wave * .65)}) rotate(11) scale(.79)">${head(p, id, { expression: 'sleep', facing })}</g>`;
  } else {
    const profile = action === 'nose_touch';
    const neck = profile ? outlined('M128 154 C139 143 158 141 177 148 C183 158 177 179 159 185 C147 188 134 177 128 154Z', id === 'archie' ? 'url(#white)' : 'url(#fur)', p, 2) : '';
    const faceArt = profile ? profileHead(p, id, { expression, facing, twitch: wave }) : head(p, id, { expression, blink, twitch: wave * (moving ? 2 : 1.2), gaze: moving ? 2 : 0, facing, mouth, whisker: wave });
    art = `${tail(p, wave, action === 'carried' ? 'carried' : 'standing')}${standingBody(p, id, { action, phase, bob, facing })}${neck}<g transform="translate(${n(headX)} ${n(headY)}) rotate(${n(rotation)}) scale(${headScale})">${faceArt}</g>`;
  }
  // Paw comes in front of the face during grooming; other limbs stay behind it.
  if (action === 'groom') art += paw(p, 151, 158 + wave * 2, -17 + wave * 5, true, .86);
  // Hearts, sleep lettering, treats and toys belong to the app's effects layer.
  const mirror = facing === 'left' ? 'translate(256 0) scale(-1 1)' : '';
  const shadow = action === 'carried' ? '' : ellipse(128, 233, sleep ? 84 : 67, sleep ? 4.8 : 5.8, '#304347', 'opacity=".095"');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frameSize}" height="${frameSize}" viewBox="0 0 256 256">${definitions(p)}${plain ? '' : shadow}<g transform="${mirror}"><g transform="translate(0 ${verticalOffset})">${art}</g></g></svg>`;
}

function duration(action, index) {
  const custom = {
    idle: [1300, 500, 110, 1100], walk: [145, 145, 145, 145], trot: [90, 90, 90, 90],
    sit: [850, 850, 850, 850], groom: [250, 220, 250, 400], sleep: [1200, 1200, 1200, 1200],
    wake: [300, 400, 250, 350], pet: [400, 500, 400, 500], carried: [350, 350, 350, 350],
    land: [90, 110, 140, 220], pounce: [220, 120, 160, 260], eat: [350, 350, 350, 450], nose_touch: [250, 350, 450, 300],
  };
  return custom[action][index];
}

function alphaBounds(data, width, height, threshold = 12) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] < threshold) continue;
    count++; minX = Math.min(x, minX); minY = Math.min(y, minY); maxX = Math.max(x, maxX); maxY = Math.max(y, maxY);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1, count };
}

async function makePet(id) {
  const target = resolve(root, 'public/pets', id);
  await mkdir(target, { recursive: true });
  const animations = {};
  const composites = [];
  const previews = [];
  const bounds = {};
  let frameIndex = 0;
  for (const action of actions) {
    animations[action] = {};
    for (const facing of directions) {
      const frames = [];
      for (let index = 0; index < frameCount; index++) {
        const svg = frameSvg(id, action, facing, index);
        const rendered = await sharp(Buffer.from(svg)).png().toBuffer();
        const { data, info } = await sharp(rendered).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const b = alphaBounds(data, info.width, info.height);
        if (b.count === 0 || b.minX < 1 || b.minY < 1 || b.maxX >= frameSize - 1 || b.maxY >= frameSize - 1) {
          throw new Error(`Empty or clipped frame: ${id}/${action}/${facing}/${index}: ${JSON.stringify(b)}`);
        }
        if (index === 0 && facing === 'right') bounds[action] = alphaBounds(data, info.width, info.height, 100);
        const x = (frameIndex % columns) * frameSize;
        const y = Math.floor(frameIndex / columns) * frameSize;
        frames.push({ x, y, w: frameSize, h: frameSize, duration: duration(action, index) });
        composites.push({ input: rendered, left: x, top: y });
        if (facing === 'right' && index === 1) previews.push({ action, buffer: rendered });
        frameIndex++;
      }
      animations[action][facing] = { frames, loop: !['wake', 'land', 'pounce', 'nose_touch'].includes(action) };
    }
  }
  const pack = {
    formatVersion: 1, id, name: palettes[id].name, atlas: 'atlas.png',
    frameWidth: frameSize, frameHeight: frameSize,
    anchor: { x: 128 * unit, y: 232 * unit },
    hitShapes: [{ x: 124 * unit, y: 185 * unit, rx: 63 * unit, ry: 45 * unit }, { x: 138 * unit, y: 111 * unit, rx: 62 * unit, ry: 58 * unit }],
    pages: Object.fromEntries(actions.map((action, index) => [action, { file: `actions/${action}.png`, offsetX: 0, offsetY: index * frameSize }])),
    animations,
    attribution: 'Original local procedural vector artwork for Archie & Jumi, informed by owner-provided kitten photographs. Photographs are not bundled. Fictional personality presets do not describe observed behavior.',
  };
  await sharp({ create: { width: columns * frameSize, height: rows * frameSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png({ compressionLevel: 9, palette: false }).toFile(resolve(target, 'atlas.png'));
  await mkdir(resolve(target, 'actions'), { recursive: true });
  for (const [actionIndex, action] of actions.entries()) {
    const page = pack.pages[action];
    const pageWidth = columns * frameSize, pageHeight = frameSize;
    const cells = composites.slice(actionIndex * columns, (actionIndex + 1) * columns)
      .map(cell => ({ ...cell, left: cell.left - page.offsetX, top: cell.top - page.offsetY }));
    const pagePath = resolve(target, page.file);
    await sharp({ create: { width: pageWidth, height: pageHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(cells).png({ compressionLevel: 9, palette: false }).toFile(pagePath);
    const actualPage = await sharp(pagePath).metadata();
    if (actualPage.width !== pageWidth || actualPage.height !== pageHeight || !actualPage.hasAlpha) {
      throw new Error(`Invalid action-page dimensions or transparency: ${id}/${action}`);
    }
    for (const facing of directions) for (const frame of animations[action][facing].frames) {
      const x = frame.x - page.offsetX, y = frame.y - page.offsetY;
      if (x < 0 || y < 0 || x + frame.w > actualPage.width || y + frame.h > actualPage.height) {
        throw new Error(`Action-page frame outside image: ${id}/${action}/${facing}`);
      }
    }
  }
  await writeFile(resolve(target, 'manifest.json'), `${JSON.stringify(pack, null, 2)}\n`);
  await writeFile(resolve(target, 'portrait.svg'), frameSvg(id, 'idle', 'right', 0, { plain: true }));
  console.log(`${palettes[id].name}: ${frameIndex} frames, full atlas ${columns * frameSize}×${rows * frameSize} (${(columns * rows * frameSize * frameSize * 4 / 1024 / 1024).toFixed(1)} MiB); 13 validated action pages ${columns * frameSize}×${frameSize} (${(columns * frameSize * frameSize * 4 / 1024 / 1024).toFixed(1)} MiB each); idle visible ${bounds.idle.width}×${bounds.idle.height}px; anchor ${JSON.stringify(pack.anchor)}.`);
  return { id, previews, bounds };
}

async function makeIcon() {
  // Namespaced gradient IDs keep the two character palettes independent.
  const portrait = (id, x, y, scale, tilt) => {
    const fragment = `${definitions(palettes[id])}<g transform="rotate(${tilt})">${head(palettes[id], id, { facing: 'right' })}</g>`
      .replaceAll('id="', `id="${id}-`).replaceAll('url(#', `url(#${id}-`);
    return `<svg x="${x}" y="${y}" width="${scale * 180}" height="${scale * 180}" viewBox="-88 -95 180 180" overflow="visible">${fragment}</svg>`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#fff5dd"/><stop offset="1" stop-color="#e8d5bd"/></linearGradient></defs>
    <rect x="8" y="8" width="496" height="496" rx="116" fill="url(#bg)"/>
    <circle cx="358" cy="164" r="102" fill="#e7bd9a" opacity=".35"/>
    <circle cx="163" cy="369" r="136" fill="#b9d2ca" opacity=".5"/>
    ${portrait('archie', 30, 111, 1.6, -10)}${portrait('jumi', 205, 126, 1.5, 9)}
    ${heart(264, 405, 1.4, 1)}${sparkle(284, 88, 1.7, '#be9150')}${sparkle(434, 383, 1.2, '#fef9e9')}
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(resolve(root, 'public/icon.png'), png);
  const sizes = [16, 32, 48, 64, 128, 256];
  const entries = await Promise.all(sizes.map((size) => sharp(png).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let index = 0; index < sizes.length; index++) {
    const cursor = 6 + index * 16;
    header[cursor] = sizes[index] === 256 ? 0 : sizes[index];
    header[cursor + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, cursor + 4); header.writeUInt16LE(32, cursor + 6);
    header.writeUInt32LE(entries[index].length, cursor + 8); header.writeUInt32LE(offset, cursor + 12);
    offset += entries[index].length;
  }
  await writeFile(resolve(root, 'public/icon.ico'), Buffer.concat([header, ...entries]));
}

async function makePreview(results) {
  const cellWidth = 144, cellHeight = 178;
  const width = actions.length * cellWidth;
  const height = cellHeight * results.length + 70;
  const labels = results.map(({ id }, row) => actions.map((action, col) => `<text x="${col * cellWidth + cellWidth / 2}" y="${row * cellHeight + 223}" text-anchor="middle" font-size="12" fill="#4f6360">${palettes[id].name} · ${action.replaceAll('_', ' ')}</text>`).join('')).join('');
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f9f4e9"/><text x="22" y="29" font-family="Segoe UI, sans-serif" font-size="20" font-weight="600" fill="#405a59">Archie &amp; Jumi · local illustration / animation contact sheet</text><text x="22" y="51" font-family="Segoe UI, sans-serif" font-size="12" fill="#697875">13 actions · 2 directions · 4 frames each · transparent sprites · no remote image generation</text><g font-family="Segoe UI, sans-serif">${labels}</g></svg>`);
  const overlays = [];
  for (const [row, result] of results.entries()) for (const [col, preview] of result.previews.entries()) {
    overlays.push({ input: await sharp(preview.buffer).resize(144, 144).toBuffer(), left: col * cellWidth, top: row * cellHeight + 70 });
  }
  const out = resolve(root, 'work');
  await mkdir(out, { recursive: true });
  await sharp(bg).composite(overlays).png().toFile(resolve(out, 'art-preview.png'));
}

async function makePairPreview() {
  const panelWidth = 480, width = panelWidth * 2, height = 330;
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="480" height="330" fill="#f9f4e9"/><rect x="480" width="480" height="330" fill="#263d3b"/><g font-family="Segoe UI, sans-serif" font-size="17" font-weight="600"><text x="22" y="29" fill="#405a59">Nose touch · peak contact pose</text><text x="502" y="29" fill="#f9f4e9">Nose touch · dark desktop</text></g><g font-family="Segoe UI, sans-serif" font-size="12"><text x="22" y="49" fill="#697875">Opposing profile heads · ${n(187 * unit)} source-pixel center separation</text><text x="502" y="49" fill="#a5c0b9">Equivalent to 110 DIP at the default 128-DIP kitten size</text></g></svg>`);
  const a = await sharp(Buffer.from(frameSvg('archie', 'nose_touch', 'right', 2))).resize(256, 256).png().toBuffer();
  const j = await sharp(Buffer.from(frameSvg('jumi', 'nose_touch', 'left', 2))).resize(256, 256).png().toBuffer();
  const overlay = [0, 480].flatMap(offset => [{ input: a, left: offset + 18, top: 65 }, { input: j, left: offset + 205, top: 65 }]);
  await sharp(bg).composite(overlay).png().toFile(resolve(root, 'work/art-pair-preview.png'));
}

await mkdir(resolve(root, 'public'), { recursive: true });
const results = [];
for (const id of Object.keys(palettes)) results.push(await makePet(id));
await makeIcon();
await makePreview(results);
await makePairPreview();
console.log('Art generated locally. Preview: work/art-preview.png. Icon: public/icon.ico.');
