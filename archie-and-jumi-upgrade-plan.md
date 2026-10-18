# Archie & Jumi — Upgrade Plan: interaction, animation and robustness

**Date:** October 17, 2026 · **Baseline:** app 1.0.1 (source in `archie-and-jumi-source.zip` → `archie-jumi-app/`) · **Status:** plan only. No existing file was modified; this document is the only addition to the working directory.

## Summary

1. **The idle freeze is an input-routing failure in the Electron main process, not a behavior bug.** The click-through overlay learns where the cursor is only through Electron's Windows mouse forwarding (`setIgnoreMouseEvents(true, { forward: true })`). That forwarding is a global low-level mouse hook. Windows silently removes such a hook the first time Electron's main thread stalls past a timeout, and the app never reinstalls it. From then on nothing can make the overlay interactive again: the kittens keep animating but ignore hover, clicks, drags and right-clicks. Section 2 has the evidence, a 15-minute confirmation procedure and the fix: the main process polls the cursor and feeds it to the renderer, re-arms the hook, resyncs state and gets a hardened watchdog with automatic recovery.
2. **Interaction and animation.** Ten of the thirteen actions are single stills and the other three are two-frame cycles, so the kittens read as photos sliding around. The best return per effort is a procedural motion layer in the renderer (bob, lean, squash, breathing, turn tweens, shadows, particles) plus a handful of behavior upgrades in the engine (a real pounce leap, treats that drop and get walked to, cursor curiosity, hold-to-pet, toy batting). New art frames come later through the existing packing pipeline and need no renderer changes.
3. **Delivery in phases:** 0 repo hygiene → 1 bug fix + robustness (1.0.2) → 2 motion + interaction (1.1.0) → 3 new frames (1.2.0) → 4 optional extras. Section 9 lists the decisions I need from you before Phase 1 starts.

---

## 1. What is in the working directory today

### 1.1 Repository

| Item | State |
| --- | --- |
| Committed | `.gitignore` (Python template), `LICENSE`, two-line `README.md`; one commit |
| Untracked | `ArchieJumiSetup.exe` (174 MB), `archie-and-jumi-source.zip` (42.5 MB), `RELEASE-NOTES.md`, `VALIDATION.md`, `archie-and-jumi-blueprint.md`, `realistic-art-prompts.md`, `SHA256SUMS.txt`, four PNGs |
| App source | Only inside the zip under `archie-jumi-app/`. The four root docs are byte-identical to `archie-jumi-app/docs/`. |

### 1.2 App

Electron 44.8.0, React 19.3, Vite 8, TypeScript 7, Vitest 5, Electron Forge + Squirrel. About 1,550 lines of TypeScript. 103 tests in 7 files. File paths below are relative to `archie-jumi-app/`.

| Layer | File | Role |
| --- | --- | --- |
| Main process | `src/main/index.ts` | overlay and settings windows, tray, shortcut, IPC, input mode, heartbeat watchdog, power and display events, recovery, smoke test |
| Preload | `src/main/preload.ts` | narrow `window.desktop` bridge (`DesktopAdapter`) |
| Behavior | `src/core/engine.ts` | pure, deterministic 30 Hz model: actions, wander, toy, pair activities, quiet mode |
| Gestures | `src/core/input.ts` | 6 DIP click-versus-drag threshold |
| Scene | `src/rendering/overlay.ts` | per-kitten canvas layers, alpha hit testing, pointer events, input-mode reports, frame loop, heartbeat |
| Assets | `src/rendering/assets.ts` | pack validation, lazy action pages (idle + one active page per kitten), 64×64 alpha masks |
| UI | `src/ui/App.tsx`, `src/ui/PetPortrait.tsx` | settings window |
| Storage | `src/main/storage.ts` | atomic JSON with backup and future-schema protection |
| Preview | `src/preview/adapter.ts` | browser-only adapter for the control panel playground |

### 1.3 How hover and dragging work today

1. `createOverlay()` calls `safeInput()`, which runs `overlay.setIgnoreMouseEvents(true, { forward: true })` (`src/main/index.ts:33-36`). The window is click-through, and Electron forwards mouse *moves* to the renderer.
2. The renderer receives `pointermove`, stores `pointer`, runs `hit()` (alpha-mask test against the sprites drawn last frame) and, only when the resulting mode string changes, sends `input-mode` to main (`src/rendering/overlay.ts:39-52` and `69-78`).
3. Main flips `setIgnoreMouseEvents(false)` when a target or capture is reported and back to `(true, { forward: true })` when neither is (`src/main/index.ts:158-163`). Reports that arrive while `quiet`, `hidden` or `paused` are dropped.
4. While interactive, real pointer events drive petting (click), dragging (over 6 DIP), the toy and the right-click menu.
5. `render()` also re-runs `updateInput()` every frame with the last known `pointer`, so a kitten walking under a stationary cursor is detected (`src/rendering/overlay.ts:107-139`).

### 1.4 Animation today

| Action | Frames per facing | Notes |
| --- | --- | --- |
| idle | 2 (2800 ms open, 140 ms blink) | |
| walk | 2 × 160 ms | fixed step rate at 38 DIP/s, so feet visibly slide |
| trot | 2 × 105 ms | 80 to 90 DIP/s |
| sit, groom, sleep, wake, pet, carried, land, pounce, eat, nose_touch | 1 | stills; left-facing is a mirror of the right-facing art |

Effects are drawn in code: one heart (pet), two static "z" glyphs (sleep), a treat rectangle (eat), the yarn ball with a curve. `pounce` does not move the kitten; it holds the crouch pose in place for 0.65 s. Automatic play moves the toy on a fixed sine path. Facing changes flip instantly.

### 1.5 Open items carried over from 1.0.1

Physical mouse passthrough, typing focus, monitor unplug, power/lock/fullscreen behavior, 100% and 200% DPI, install/upgrade/uninstall, a long soak, GPU use and input latency were never measured (release notes). The native smoke test injects events with `webContents.sendInputEvent`, which goes straight to the renderer and bypasses the forwarding hook entirely, so it cannot observe the bug in Section 2. One 150% monitor still reports an overlay three DIP taller than its work area.

---

## 2. Bug: kittens stop reacting after being idle

### 2.1 Symptom

After the app has been running for a while, typically after the machine or the user has been idle, both kittens keep animating but no longer react to the cursor: no grab cursor, no petting, no dragging, no right-click menu. Expected from the analysis (please confirm during 2.3): Hide All → Show All does not fix it, but changing the monitor in the tray or restarting the app does.

### 2.2 Root cause

**While click-through, the overlay has exactly one source of cursor position: Electron's mouse forwarding. On Windows that forwarding is a global low-level mouse hook that Windows can silently remove, and the app has no way to notice and no second source.**

Evidence chain:

1. Electron implements `forward: true` on Windows in `shell/browser/native_window_views_win.cc`. `SetForwardMouseMessages(true)` installs `mouse_hook_ = SetWindowsHookEx(WH_MOUSE_LL, MouseHookProc, nullptr, 0)` once per process, and `MouseHookProc` posts a `WM_MOUSEMOVE` to every forwarding window whose client area contains the cursor. The hook callback runs on Electron's main (UI) thread.
2. Microsoft's `LowLevelMouseProc` documentation: the hook procedure must return within `LowLevelHooksTimeout` (capped at 1000 ms since Windows 10 1709). "On Windows 7 and later, the hook is silently removed without being called. There is no way for the application to know whether the hook is removed." Microsoft also says such hooks should run on a dedicated thread, which Electron does not do.
3. Electron keeps the hook handle in a static and only calls `SetWindowsHookEx` when that handle is null. It unhooks and nulls the handle only when the last forwarding window calls `setIgnoreMouseEvents(false)`. Windows' silent removal leaves the stale handle in place, so every later `setIgnoreMouseEvents(true, { forward: true })`, including the app's own `safeInput()` on Show All, resume, quiet toggles and display changes, is a no-op for the hook.
4. In this app the only thing that ever makes the window interactive is the renderer reporting a hover target, and the renderer only learns the cursor position from forwarded moves (or from real events, which need the window to be interactive first). Once the hook is gone the loop is closed: no moves → no target → never interactive → no moves. `render()` keeps re-testing a stale `pointer`, which cannot help.
5. The main thread only has to stall once, for about a second, in the whole session. Realistic triggers: display sleep and wake, Modern Standby transitions, lock and unlock, a GPU driver reset, a UAC prompt or secure-desktop switch, heavy disk or system load, a long garbage-collection or IPC burst. That is why it correlates with idling and uptime rather than with anything the kittens do.

Adjacent documented behavior that compounds it: Electron's docs now note that "mouse forwarding will stop working temporarily if a window with higher privileges (integrity level) is the foreground window" (docs PR #53026, targeted at the 44.x line this app pins), and issue #33281 reports forwarding failing while Task Manager or Device Manager is focused. Those are meant to be temporary; combined with the timeout removal they can become permanent.

### 2.3 Confirmation before changing code (about 15 minutes)

1. Reproduce: leave the app running, lock and unlock the PC or let the display sleep, then hover a kitten.
2. While frozen, use the tray: **Hide All → Show All**. Expected: still frozen, because this path only re-runs the no-op `safeInput()`.
3. While frozen, switch **Monitor** to another display and back (or restart the app). Expected: hover works again, because the overlay is recreated; the old window unhooks on destruction and the new one installs a fresh hook.
4. Decisive and optional: a temporary dev-only tray item "Re-arm input" that runs `overlay.setIgnoreMouseEvents(false); overlay.setIgnoreMouseEvents(true, { forward: true })`. If that alone restores hover, the diagnosis is confirmed. This two-line experiment is not part of the final design.

If step 2 fixes it instead, the cause is elsewhere (most likely the dropped-report race in 2.4 a). Phase 1 still covers that case, but tell me and I will re-trace before building.

**Outcome, October 18, 2026.** The native experiment did not reproduce hook removal on this PC (Windows 11 build 26200, Electron 44.8). With real 1-pixel cursor moves, forwarding kept working after main-thread stalls of 2.5 s and 6 s, twelve repeated 1.2 s stalls, hide and show of the overlay, recreation of the overlay window, and a GPU process restart. The trigger behind the reported freeze is therefore unconfirmed. Remaining candidates are session transitions (lock, sleep, secure-desktop prompts) and elevated foreground windows, which could not be exercised unattended. Phase 1 ships with polling as the default routing (F8), so hover no longer depends on forwarding under any of these conditions, and the diagnostics log (F7) will record the sequence if the kittens ever stop reacting again. Details are in `archie-jumi-app/docs/VALIDATION.md`.

### 2.4 Other weaknesses found in the same code paths

a. **No resync.** The renderer sends `input-mode` only when its mode string changes (`lastMode`), while main silently drops reports that arrive during `hidden || paused || quiet` (`src/main/index.ts:160`). A report dropped during a lock transition leaves the two sides disagreeing until the hover target changes again.
b. **Watchdog false positives after sleep.** The 3.5 s heartbeat check uses `Date.now()` (`src/main/index.ts:275`). A standby that does not emit `powerMonitor` `suspend` first, or a resume where the renderer's 1 s timer fires late, trips `recover()`, which hides the kittens and demands a manual Show All. Recovery is never attempted automatically.
c. **Overlay recreated too eagerly.** `display-metrics-changed` recreates the overlay on *any* metric change of *any* display (`src/main/index.ts:270-271`), even when the selected display's work area and scale did not change. Each recreation discards the current activity (play, pair, drag), flashes, restarts asset decoding and resets input from scratch. The benchmark script already notes that "display startup can destroy the first overlay and replace it".
d. **System-wide mouse latency.** Because the forwarding hook runs on Electron's main thread, every mouse move on the whole system waits for that thread while the app is click-through. Any main-thread work (saves, tray menu rebuilds, bootstrap cloning) becomes mouse stutter in every application. This is a reason to stop using forwarding entirely, not only to re-arm it.
e. **Stale pointer after hook loss.** When a kitten walks under the last known cursor point, the window turns interactive in that region and swallows clicks meant for the application underneath.
f. **Occlusion.** Chromium's Windows native occlusion tracking (`CalculateNativeWinOcclusion`, enabled by default) can mark a window hidden when something covers it. `backgroundThrottling: false` keeps timers alive, but a hidden compositor stops `requestAnimationFrame`. This is not implicated by the reported symptom (hit testing does not need rAF), but a stalled frame loop would freeze the kittens visually and trip the watchdog, so it deserves a guard and a measurement.

### 2.5 Fix design (Phase 1)

**F1. Cursor feed from the main process (primary mechanism).**

- Main polls `screen.getCursorScreenPoint()` on a 33 ms timer (30 Hz) while the overlay is visible, click-through, not paused and not quiet. One `GetCursorPos` call per tick costs microseconds; nothing is sent when the point has not changed. Polling stops while the window is interactive, because real events flow then.
- The renderer publishes an *interest region* (union of the drawn kitten rectangles and the toy, inflated by 24 DIP, rounded to 4 DIP) whenever it changes. Main evaluates on every tick and on every region update, and sends `cursor { generation, x, y, inside }` only when the cursor is inside the region, plus one `inside: false` message when it leaves. Steady-state IPC is zero while you work elsewhere on screen. Coordinates are converted to scene DIP exactly as `bootstrap()` already does (`cursor - workArea origin`); a cursor on another display counts as outside.
- Renderer: `onCursor` sets `pointer` and calls the existing `updateInput()`; it is ignored while a pointer is captured. `hit()`, the alpha masks and the `input-mode` contract stay exactly as they are, so the existing smoke assertions keep their meaning. The browser preview adapter gets a no-op.
- Latency: at most 33 ms to notice hover, inside the blueprint's 100 ms target.
- The cursor source is injectable (`cursorSource: () => Point`) so the smoke test can script it.

**F2. Hook re-arm (safety net during the transition).** `rearmForwarding()` = `setIgnoreMouseEvents(false)` immediately followed by `setIgnoreMouseEvents(true, { forward: true })` in the same tick, so no message pump runs between them and no click can leak. Only when no target or capture is active. Call it on Show All, `resume`, `unlock-screen`, after display changes and every 60 s while idle and click-through.

**F3. Input-mode resync.** The renderer resends its current mode every 2 s even if unchanged. Main computes `ignore = !(target || capture) || hidden || paused || quiet` from its own authoritative state in one `applyInputMode()` function and calls `setIgnoreMouseEvents` only when the computed value changes or when forced, instead of trusting the last message. Every state transition (hide, show, pause, resume, quiet) goes through the same function.

**F4. Watchdog hardening and automatic recovery.**

- Heartbeat payload becomes `{ generation, frames, pointerSeenAt }`, where `frames` counts rAF ticks since the previous beat.
- Main requires three consecutive missed 1 s beats, not a single 3.5 s gap; a 10 s grace after any `powerMonitor`, display or show event; `frames === 0` for three beats while visible means the frame loop stalled, so send `resume` to re-kick rAF before anything else.
- `recover()` first tries an automatic overlay recreation (at most 3 per 10 minutes, with backoff) carrying over saved positions, and only then falls back to hidden plus notice.
- Also handle `app.on('child-process-gone')` for the GPU process (transparent windows can go opaque or black after a GPU restart) with the same recreate path.

**F5. Display-change handling.** Keep the 200 ms debounce, then compare the selected display's `workArea` and `scaleFactor` with the live overlay bounds; recreate only when they differ, otherwise do nothing. Before recreation, ask the renderer to push positions (add a `positions` send on the `pause` lifecycle) so nothing moved in the last 5 s is lost.

**F6. Occlusion guard (measure, then keep or drop).** `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')` before `app.whenReady()`. Measure resting CPU with `scripts/benchmark.mjs` with and without; keep it only if resting cost stays under the 1% target. Log `BrowserWindow.isOccluded()` in diagnostics either way.

**F7. Local diagnostics.** A ring-buffer log at `userData/diagnostics.log` (rotated at 256 KB, offline, no screenshots): input-mode transitions, feed start and stop, re-arms, heartbeat misses, recoveries, occlusion, power and display events, each with a timestamp. A "Copy diagnostics" button in Settings. This is what makes the soak test and any future report conclusive.

**F8. Decision: hybrid or polling-only.** Ship Phase 1 as hybrid (F1 + F2) so nothing regresses. During validation, measure hover latency with forwarding disabled (`setIgnoreMouseEvents(true)` with no `forward`). If it stays at or under 50 ms, make 1.0.2 polling-only: one code path, no global hook, no system-wide mouse latency (2.4 d), and immunity to the documented foreground-window cases. **My recommendation is polling-only.**

### 2.6 Acceptance for the bug fix

| Check | How |
| --- | --- |
| Unit: feed decision | pure `cursorFeedDecision(previous, cursor, region)` returning send / skip / leave, in `tests/cursor-feed.test.ts` |
| Unit: watchdog policy | pure `WatchdogPolicy` with an injected clock: consecutive misses, grace windows, backoff, frame-stall detection |
| Smoke: hook dead | force `setIgnoreMouseEvents(true)` without forward, script the cursor source over Archie, assert `inputMode.target === 'archie'` within 100 ms and `null` after moving away |
| Smoke: power cycle | call the exported pause and resume handlers; assert no recovery notice and hover restored |
| Smoke: display no-op | emit `display-metrics-changed` with unchanged metrics; assert `generation` unchanged |
| Smoke: frame stall | stop rAF through `executeJavaScript`; assert automatic recreate, pets visible, no manual Show All |
| Manual, physical mouse | hover and drag after 30 min idle; after lock and unlock; after sleep and wake; after a UAC prompt; with Task Manager focused; after a fullscreen video; after monitor sleep; typing in another app while petting; clicks, scroll and drags pass through empty space |
| Soak | 8 or more hours with diagnostics on; zero stuck intervals; CPU and memory re-measured with `scripts/benchmark.mjs` (targets unchanged: resting under 1%, under 500 MiB) |

---

## 3. Interaction upgrades (Phase 2)

Principles: gentle by default, never steals focus, never blocks clicks meant for other apps, every new behavior respects Quiet Mode and Gentler motion, and the personality sliders visibly change behavior.

| # | Feature | Behavior | Where | Priority |
| --- | --- | --- | --- | --- |
| I1 | Cursor awareness | When the cursor rests within 1.6× size of an idle, sitting or grooming kitten for 2.5 s: turn to face it; with a probability from playfulness and sociability, walk to 0.8× size from it and sit. Cancel if the cursor leaves or moves fast. Per-kitten cooldown 90 to 180 s. | engine: new `cursor` command (at most 10 Hz, only inside an attention region sent by the feed); new movement kind `curious` | High |
| I2 | Hold-to-pet | Press without moving for 350 ms → continuous `pet` with a heart every 0.8 s and a looping purr until release (cap 8 s). A quick click keeps today's 2 s pet. | `input.ts` hold threshold, engine `pet { held }`, overlay, sound | High |
| I3 | Real pounce | During `pounce` the kitten leaps along an arc toward the toy (0.45 s, height 0.35× size) and lands with a squash. In automatic play the toy is batted 60 to 120 DIP away afterwards so the chase continues; in held play nothing is batted. | engine `followToy` (from/to in state), motion layer | High |
| I4 | Treat that drops | The treat appears 1.1× size ahead, falls for 0.35 s with a small bounce; the kitten walks to it if farther than 0.4× size, eats for 2.8 s, crumbs fade. The treat becomes a scene entity in the snapshot, not a glyph. | engine `treat` entity, overlay effect | High |
| I5 | Drag feel | The carried kitten swings with horizontal velocity (±8°, damped); the shadow detaches and shrinks; landing squash plus a dust puff. Release still places it where dropped, as the blueprint requires. | motion layer; renderer derives velocity from consecutive positions | Medium |
| I6 | Yarn upgrade | The ball rolls (rotation = distance ÷ radius), the thread trails with lag, the ball bounces when dropped; automatic play uses random waypoints instead of a fixed sine. | overlay toy drawing; engine toy waypoints | Medium |
| I7 | Idle variety | Look-around (brief facing turn), a stretch after sleep (reuse the wake pose), sit → groom → sit chains, an occasional edge-sit near the bottom. | engine `finishAction` | Medium |
| I8 | Pair polish | A heart puff at nose contact; synchronized breathing in the shared nap. | overlay effects | Low |
| I9 | Right-click "Come here" | The kitten walks to the cursor's current position and sits. | main menu → `move-to` command | Low |
| I10 | Settings | "Curious about the cursor" toggle (default on). Hold-to-pet is always on. Additive preference with a default, so the save schema stays at version 1. | `App.tsx`, `defaults.ts`, `validation.ts` | Medium |

Personality mapping so the sliders matter: playfulness → chase, bat and approach probability plus trot preference; sociability → pair frequency and cursor approach; energy → wander frequency and sleep length (as today) plus walk speed ±20%.

---

## 4. Animation upgrades

### 4.1 Procedural motion layer (Phase 2, no new art)

New pure module `src/core/motion.ts`: `poseFor(pet, context) → { dx, dy, scaleX, scaleY, rotation, shadowScale, shadowLift }`, unit-tested in isolation and applied by the renderer around the ground anchor (frame point 256,464) so the feet stay planted.

| Action | Procedural motion |
| --- | --- |
| walk, trot | vertical bob of 2.5% of size on the step cycle; 2 to 3° lean into the direction of travel; step period derived from speed to fix foot slide: `clamp(0.25 × size ÷ speed, 180, 450)` ms per frame; consider raising the base walk speed from 38 to about 55 DIP/s (energy-scaled) and tune by eye |
| idle, sit, groom | breathing scaleY ±0.7% on a 3.4 s cycle; groom adds a ±2° periodic tilt |
| sleep | breathing ±1.5%; "z" glyphs rise and fade instead of static text |
| pet | ±2° nuzzle wobble at 1 Hz; hearts become particles that rise, drift and fade |
| carried | pendulum rotation from velocity; shadow stays on the ground at 60% size and 50% alpha |
| land | squash scaleY 0.88 → 1 and scaleX 1.08 → 1 over 220 ms, ease-out; dust puff |
| pounce | leap arc from the engine; the shadow shrinks at the apex |
| wake | stretch scaleX 1 → 1.06 → 1 across the clip |
| eat | 2 px bob at 2 Hz; crumbs |
| facing change | turn tween: scaleX 1 → 0 → 1 over 140 ms, mirrored at the midpoint, instead of an instant flip |
| action change | 120 ms crossfade between the outgoing and incoming still; cuts stay inside cycles; evaluate on the photographic frames and drop it if it reads as a double exposure |

Renderer changes: inflate each kitten layer by 15% to leave room for rotation and scale; transform the pointer into frame space inside `hit()` so alpha hit testing stays exact under transforms; render at rAF rate only while a tween or movement is active, at 30 Hz during cycles, and event-driven when nothing changes (the existing `visual` dedupe). Gentler motion disables bob, lean, wobble, particles, crossfades and breathing (identity pose), matching today's reduced-motion contract.

### 4.2 New frames (Phase 3, optional)

The pack contract already allows up to 120 frames per clip, so new in-betweens need no renderer change and keep `formatVersion: 1`. Generate with the same prompt template as `realistic-art-prompts.md` (2×2 sheets, right-facing, transparent, same scale and camera), add the sheets and clips to `scripts/pack-realistic-art.mjs` (`sheets`, `clips`, optional `crops.json` overrides) and review the contact sheets it already produces.

| Sheet | Poses | Enables |
| --- | --- | --- |
| E | walk_c, walk_d, sleep_b (inhale), eat_b (chew) | 4-frame walk, breathing sleep, chewing |
| F | pounce_crouch, pounce_air, pounce_land, groom_b | 3-frame pounce, 2-frame groom |
| G | trot_c, trot_d, pet_b (lean into the hand), wake_b | 4-frame trot, 2-frame pet and wake |
| H (optional) | left-facing idle, sit, sleep, walk_a | removes mirrored markings for the most-seen poses |

Risk: identity drift between generated frames. Mitigation: the existing contact-sheet review, the stills kept as fallback (a manifest can mix 1-frame and N-frame clips), and the packing script's clipping and alpha checks.

---

## 5. Robustness beyond the bug

- **R1 Overlay state carry-over.** Serialize the engine snapshot on `pause` and before recreation; restore positions and the current action in the new renderer. Today only normalized positions survive, and only as of the last 5 s save.
- **R2 Always-on-top re-assert** with `setAlwaysOnTop(true)` on show and resume, guarding against z-order loss after secure-desktop switches. Verify during the soak.
- **R3 Startup race.** Debounce display events during the first 2 s and compare metrics (F5) so the first overlay is not destroyed and rebuilt.
- **R4 Save cadence.** Save positions on `pause` as well as on drag end and every 5 s.
- **R5 Electron cadence.** This area is actively changing upstream (forwarding regression tests in PR #54607, the UIPI docs note in #53026, stuck click-through after reload in #49982). Stay on a supported line and re-run the smoke suite on every upgrade. Polling-only (F8) minimizes exposure.
- **R6 Repo hygiene (Phase 0).** Unzip `archie-jumi-app/` into the repo and commit it. Replace the Python `.gitignore` with Node and Electron entries (`node_modules/`, `dist/`, `out/`, `work/`, `test-results/`, `*.exe`, `*.zip`). Keep the installer and the zip out of git (publish them as release assets, or use LFS). Add `npm run check` (typecheck + test). Record Node 24 LTS in `engines` and `.nvmrc`.
- **R7 Known gap kept visible.** The three-DIP overlay height discrepancy on the 150% monitor stays an open item; the diagnostics log should record bounds versus work area on every overlay creation.

---

## 6. Test and validation plan

| Level | Additions |
| --- | --- |
| Unit (Vitest) | `cursor-feed.test.ts`, `watchdog.test.ts`, `motion.test.ts` (pose math, reduced motion yields identity, turn tween timing), `engine.test.ts` (pounce moves toward the toy, toy batted after an automatic pounce, treat walk-to-eat, cursor approach plus cooldown, held pet duration cap, idle variety is seeded), `input.test.ts` (hold threshold), `validation.test.ts` (new preference defaults) |
| Native smoke (`npm run smoke`) | the six scenarios in 2.6 plus the fifteen existing assertions; the scripted cursor source and exported lifecycle handlers make them deterministic |
| Browser UI (`tests/ui-browser.ts`) | the new Settings toggle; playground sanity for the motion layer (no page errors, canvases attached) |
| Performance (`scripts/benchmark.mjs`) | before and after each phase; resting under 1% CPU, play under 3%, under 500 MiB; hidden produces zero draws; add a hover-latency sample (feed send to `input-mode` receipt) to the report |
| Manual | the physical-mouse list in 2.6, plus a visual review of every action on light, dark and patterned backgrounds at 96, 128 and 192 DIP and at 100%, 125%, 150% and 200% scaling |
| Soak | 8 or more hours with diagnostics on, repeated once after Phase 2 |

---

## 7. Phases

| Phase | Scope | Version | Size | Exit criteria |
| --- | --- | --- | --- | --- |
| 0 | R6 repo hygiene; build and tests green from the committed tree | n/a | S | `npm run check`, `npm run build`, `npm run smoke` pass |
| 1 | F1 to F8, R1 to R4, R7, diagnostics, tests in 2.6 | 1.0.2 | M | smoke additions pass; 8 h soak with no stuck interval; benchmark within targets; decision on polling-only recorded |
| 2 | motion layer (4.1), I1 to I7, I10, personality mapping | 1.1.0 | L | new engine and motion tests; visual review on light, dark and patterned backgrounds; benchmark play at or under 3% CPU |
| 3 | sheets E to G (H optional), pack script extension | 1.2.0 | M art + S code | contact sheets reviewed; pack validation passes; no renderer change needed |
| 4 | I8, I9, sound polish, left-facing art | later | S to M | as above |

Phase 1 should ship alone first. It is the only phase that changes how input reaches the kittens, and validating it in isolation keeps the soak result attributable.

---

## 8. File change map

| File | Change | Phase |
| --- | --- | --- |
| `src/main/index.ts` | `applyInputMode()`, cursor feed timer, `rearmForwarding()`, watchdog policy, auto-recovery with backoff, display comparison, GPU-gone handler, diagnostics hooks, occlusion switch, new IPC channels (`cursor`, `interest`, `diagnostics`) | 1 |
| `src/main/cursor-feed.ts` (new) | pure feed decision plus the timer wrapper with an injectable cursor source | 1 |
| `src/main/watchdog.ts` (new) | pure watchdog policy with an injected clock | 1 |
| `src/main/diagnostics.ts` (new) | ring-buffer log, rotation, copy-to-clipboard | 1 |
| `src/main/preload.ts`, `src/shared/types.ts` | `onCursor`, `setInterest`, richer heartbeat payload, `copyDiagnostics` on `DesktopAdapter` | 1 |
| `src/preview/adapter.ts` | no-op implementations of the new bridge members | 1 |
| `src/rendering/overlay.ts` | consume the feed, publish the interest region, periodic resync, rAF liveness in heartbeat, positions on pause | 1 |
| `src/rendering/overlay.ts` | transforms around the anchor, pointer inverse-transform in `hit()`, adaptive frame rate, particles and effects, toy rolling and thread, treat entity | 2 |
| `src/core/motion.ts` (new) | `poseFor()` and easing helpers | 2 |
| `src/core/engine.ts` | pounce leap and batting, treat entity, cursor awareness, held pet, idle variety, speed scaling, waypoints | 2 |
| `src/core/input.ts` | hold threshold | 2 |
| `src/shared/defaults.ts`, `src/shared/validation.ts`, `src/ui/App.tsx` | `curious` preference and toggle; "Copy diagnostics" button | 1 and 2 |
| `scripts/pack-realistic-art.mjs`, `artwork/realistic/crops.json` | sheets E to H, extended clips | 3 |
| `tests/*` | as listed in Section 6 | 1 to 3 |
| `docs/release-notes.md`, `docs/VALIDATION.md`, `README.md` | per release | each |

---

## 9. Decisions needed from you

1. **Polling-only or hybrid** for input routing after validation. Recommendation: polling-only (Section 2.5, F8).
2. **Cursor curiosity on by default?** Recommendation: on, with the "Curious about the cursor" toggle, because it is the single most "alive" behavior available without new art. Say so if kittens walking toward the cursor would distract you while working.
3. **Phase 3 art.** Are you willing to generate roughly 12 to 16 more poses per kitten with the same imagegen workflow and identity references? If not, Phase 2 alone still delivers most of the visible improvement.
4. **Repository layout.** Commit the app source under `archie-jumi-app/` in this repo and drop the installer and zip from git (Section 5, R6)? Recommendation: yes, before any code changes, so every later step is reviewable as a diff.
5. **Anything from Section 3 you do not want.** Everything there is optional and independently removable.

---

## Sources

- Electron `shell/browser/native_window_views_win.cc` (`SetForwardMouseMessages`, `MouseHookProc`): https://github.com/electron/electron/blob/main/shell/browser/native_window_views_win.cc
- Electron BrowserWindow docs, `setIgnoreMouseEvents` and the `forward` option: https://www.electronjs.org/docs/latest/api/browser-window
- Microsoft, `LowLevelMouseProc` (timeout and silent removal): https://learn.microsoft.com/windows/win32/winmsg/lowlevelmouseproc
- Electron docs PR #53026 (forwarding stops while a higher-integrity window is foreground): https://github.com/electron/electron/pull/53026
- Electron issue #33281 (forwarding fails with certain foreground windows): https://github.com/electron/electron/issues/33281
- Electron issue #15376 (forwarding stops after a reload): https://github.com/electron/electron/issues/15376
- Electron issue #49982 (stuck click-through after renderer crash and reload): https://github.com/electron/electron/issues/49982
- Electron PR #54607 (forwarding regression tests): https://github.com/electron/electron/pull/54607
- Chromium `ui/base/ui_base_features.cc` (`kCalculateNativeWinOcclusion`, Windows-only, enabled by default): https://source.chromium.org/chromium/chromium/src/+/main:ui/base/ui_base_features.cc
- Chromium blog, native window occlusion on Windows: https://blog.chromium.org/2021/12/chrome-windows-performance-improvements-native-window-occlusion.html
