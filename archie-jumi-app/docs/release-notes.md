# Archie & Jumi — release notes

## 1.1.0 — livelier kittens

Windows 11 x64 · October 18, 2026. Includes everything in 1.0.2.

### New things to do with Archie and Jumi

- **Hold to pet.** Press on a kitten and keep still. After about a third of a second it becomes a continuous pet, with hearts and a soft looping purr, for up to eight seconds. A quick click is still the two-second pet, and a short hold never gives less than a click.
- **Curious kittens.** When the pointer rests near a sitting or idle kitten for about two and a half seconds, it turns to look, and sometimes walks over and sits. Each kitten then waits 90 to 180 seconds before noticing again. Settings → Your calm corner → Curious about the cursor turns this off. It is on by default and has no effect in Quiet Mode.
- **Come here.** In a kitten's right-click menu, choose Come here, then point at a spot and hold the pointer still for a moment. From the tray, the kitten walks to where the pointer last rested on the desktop.
- **Real pounces.** During yarn play a kitten crouches, leaps onto the yarn and lands softly. In automatic play a landing can bat the yarn away, so the chase goes on. The yarn rolls as it moves and trails its thread.
- **Treats you can see.** A treat drops in front of the kitten and bounces once. The kitten walks over, eats it, and leaves a few crumbs.
- **More everyday variety.** Kittens look around, groom between sits, stretch after waking, and now and then sit near the bottom of the screen. More energetic kittens walk and trot a little faster.
- **Better together.** A nose boop ends with a small heart puff, and kittens napping together breathe in step.

### Motion

The kittens now move with procedural motion layered on the photographic poses:

- breathing while sitting and sleeping, and a bob and lean while walking
- a quick turn instead of an instant flip
- a soft squash on landing and a stretch on waking
- a gentle swing while carried, which eases back when let go
- an arc through the air during a pounce, with the shadow staying on the ground

Poses blend over 120 ms when the action changes. The previous pose stays on screen while the next one loads, so the idle pose no longer flashes between actions.

Hit testing follows exactly what is drawn, so a kitten in mid-leap is clickable where it is, not where it was. Hover also stays steady while a kitten turns or lands under a resting pointer. The large curiosity areas around kittens never count as hover, so 1.0.2's guard against stale hover still works next to them.

Gentler motion turns all of this off: no procedural motion, particles or blends, and simple static hearts and z's as before. Treats appear at the kitten's paws, and Come here moves the kitten at once. Quiet Mode keeps the kittens resting and adds none of the new behaviour.

### Art pipeline for more frames

`npm run art` can now use four optional pose sheets per kitten (E to H). They add four-frame walks and trots, a three-stage pounce, breathing sleep, chewing, two-frame grooming, petting and waking, and true left-facing idle, sit and sleep poses. Without those sheets the packs are byte-identical to today's. `docs/phase3-art-prompts.md` has ready-to-use prompts and review steps. No new artwork has been generated yet. The packer also gained `--source-dir`, `--output-dir`, `--work-dir` and `--check`, and it replaces packs safely: a failed write leaves the previous pack intact.

### Validation and resource use

TypeScript, 472 unit tests in 29 files, the browser UI check in Edge (now including the curious toggle and hold-to-pet), and the native smoke test with 45 required checks passed. The new native checks cover:

- the motion captures during play, a pounce, a treat and a held pet, with no page errors
- the treat flow, hold-to-pet and a quick click
- hover on a walking and turning kitten, and in mid-leap: the lifted torso hovered every time (7 of 7), a ground point that only an untransformed sprite would cover never did (0 of 6)
- Come here from both menus, the curious toggle, and curiosity end to end (the kitten turned after 2.5 s)

The 37 checks from 1.0.2 still pass. Hover latency was at most 21 ms.

| State | 1.0.2 CPU | 1.1.0 CPU | 1.1.0 combined working set |
| --- | ---: | ---: | ---: |
| Resting/sleeping | 0.60% | 0.80% | 366 MiB |
| Awake, idle variety (new phase, not gated) | — | 0.79% | 382 MiB |
| Automatic yarn play | 1.84% | 2.26% | 400 MiB |
| Hidden | 0.10% | 0.03% | 388 MiB |

CPU is a share of total system capacity on this Windows 11 / Ryzen 5 5500U machine; each phase lasted about eight seconds. Resting costs more than in 1.0.2 because breathing and drifting z's are now drawn, at 4 frames a second for napping kittens and 3 after 20 seconds of deep nap. Hidden kittens draw nothing.

### Install

`npm run make` builds `out/make/squirrel.windows/x64/ArchieJumiSetup.exe` (unsigned, same application identity as 1.0.x, so it upgrades in place). The 1.1.0 installer was built and its packaged app passed the native smoke test; it was not installed.

### Known limits

- The purr loop has only been checked silently. Its level and texture still need a listen.
- The new poses blend across photographic stills. Multi-frame art from sheets E to H would make walking, pouncing and grooming smoother.
- The app does not yet follow Windows' "Animation effects" setting; turn on Gentler motion in Settings instead.
- Physical-mouse checks, real lock and sleep cycles and a long soak remain open, as listed for 1.0.2.

## 1.0.2 — kittens keep reacting

Windows 11 x64 · October 18, 2026

### What changed

**Hover no longer depends on Windows mouse forwarding.** In 1.0.1 the click-through overlay learned where the cursor was only from Electron's mouse forwarding, a process-wide low-level mouse hook. When that path stopped delivering mouse moves, nothing could make the kittens clickable again. In 1.0.2 the main process reads the cursor position about 30 times a second and tells the scene only while the cursor is near a kitten or the yarn. No global mouse hook is installed by default.

- On this PC the kittens became clickable within 21 ms of the cursor reaching them, the worst of fifteen samples over three runs, and turned click-through again within a few milliseconds of it leaving.
- One decision in the main process now controls whether the overlay accepts clicks. If its own cursor reading has been away from every kitten for 300 ms, the overlay turns click-through even if the scene still reports a hover. A stale report therefore cannot leave the whole screen swallowing clicks.
- The scene resends its input state every second. The main process re-applies it after hide, show, lock, unlock, sleep, resume, Quiet Mode and display changes.
- A drag whose button release was never seen now ends on the next mouse move.

**Automatic recovery.** A crashed, hung or stalled scene, a lost graphics process, or a scene that fails to start is rebuilt automatically. The kittens keep their places, facing and naps. Up to three rebuilds in ten minutes happen without any action. After that the kittens stay hidden with a notice until Show All, and a hung scene is shut down so it cannot keep using the processor. In 1.0.1 every failure hid the kittens until Show All.

**Fewer interruptions.** Display events now rebuild the scene only when the kittens' monitor really changed its size, position or scale. 1.0.1 rebuilt it on any change to any monitor, including one at every startup. If the browser engine stops delivering animation frames, for example because it wrongly treats the window as covered, timers keep the scene animating. Chromium's native occlusion tracking is now off for the same reason; it made no measurable difference to resource use.

**Copy diagnostics.** Settings → A place on your desktop → Copy diagnostics copies a short local log to the clipboard. It lists versions, input routing, display count and scale factors, and recent input, recovery, power and display events. The log is kept in the app data folder as `diagnostics.log` and rotated at 256 KB. It holds no cursor positions, window titles or file names, and nothing leaves the computer.

**Troubleshooting switches.** `--input-routing=hybrid` adds 1.0.1-style forwarding on top of polling and re-arms it automatically. `--native-occlusion` turns Chromium's occlusion tracking back on. README → Troubleshooting explains how to pass them to the installed app.

### About the "stops reacting after a while" bug

The upgrade plan named its most likely cause: Windows silently removing Electron's mouse hook after Electron's main thread stalls. A native experiment on this PC did not reproduce that. On Windows 11 build 26200 with Electron 44.8, real 1-pixel cursor moves kept being forwarded after each of these:

- main-thread stalls of 2.5 s and 6 s, and twelve repeated stalls of 1.2 s, with cursor moves during every stall
- hiding and showing the overlay, which 1.0.1 did on every lock and unlock
- destroying and recreating the overlay window, which 1.0.1 did on every display event
- a killed and restarted GPU process

The exact trigger on this PC is therefore still unknown. Reports from other projects describe low-level hooks dying after session transitions such as lock, sleep or a secure-desktop prompt, and Electron documents that forwarding pauses while an elevated window is in front. Those could not be exercised unattended. 1.0.2 does not use the forwarding path by default, so none of them can stop the kittens from noticing the cursor. If the kittens ever stop reacting again, use Copy diagnostics before restarting the app; the log will show what happened.

The opt-in check `node scripts/run-electron.mjs . --smoke-test --hook-loss-check`, run after a build, repeats the stall experiment. It sends only 1-pixel cursor moves, never clicks, and restores the cursor position.

### Validation and resource use

TypeScript, 256 unit tests in 17 files, the browser UI check in Chrome and Edge, and the native smoke test with 37 required checks passed. The native test covers hover through the cursor feed, hover latency, the hover guard, drag capture and release, a missed button release, lock and unlock, hybrid re-arming, display changes with and without real metric changes, a starved frame loop, a hung scene, a crash, a lost graphics process, the recovery budget and Show All, and settings-only diagnostics. See `VALIDATION.md`.

A short native benchmark on this Windows 11 / Ryzen 5 5500U machine, with Settings closed, measured:

| State | 1.0.1 CPU | 1.0.2 CPU | 1.0.2 combined working set |
| --- | ---: | ---: | ---: |
| Resting/sleeping | 0.49% | 0.60% | 342 MiB |
| Automatic yarn play | 1.59% | 1.84% | 365 MiB |
| Hidden | 0.03% | 0.10% | 357 MiB |

CPU is a share of total system capacity. Each phase lasted about eight seconds. These are measurements on this machine, not guarantees. With `--native-occlusion` the figures were the same within noise.

### Remaining acceptance work

Checks with a physical mouse remain to be done: clicks, scrolling and dragging through empty space, and hovering, petting and dragging the kittens. Real lock, unlock and sleep cycles, an eight-hour soak with diagnostics, monitor unplug and reconnect, 100% and 200% scaling, and an upgrade install over 1.0.1 are also still open. The right 150% monitor still reports an overlay three DIP taller than its work area. The scene uses the work area, and the difference is now logged.

## 1.0.1 — realistic appearance update

Windows 11 x64 · October 17, 2026

### What changed

The profile cards, desktop kitten sprites and application icon now use realistic artwork based on the supplied photos. Archie retains his gray tabby coat, white facial blaze, muzzle, chest and paws. Jumi retains the orange tabby coat, cream muzzle and light paw tips.

The profile cards use static transparent portraits with neutral backgrounds. Cartoon drawings, decorative sparkles and the cartoon fallback have been removed. Both desktop kittens use matching realistic pose packs for all thirteen existing actions. Petting, dragging, treats, yarn play, naps, shared activities, Quiet Mode and saved settings remain available.

The artwork was created with the built-in imagegen tool using the supplied photographs. It is a generated interpretation, not an unchanged photograph. Unseen markings and body details are reconstructed. The original photos are not bundled, and the installed app operates offline without uploading images.

### Artwork details and limits

- Sixteen supplied poses per kitten, mapped to thirteen actions in both directions.
- Idle/blinking, walking and trotting use multiple poses. The other ten actions hold a distinct pose; they are not fully animated multi-frame sequences.
- Left-facing versions currently mirror the supplied right-facing artwork. Separate left-side references would improve asymmetric markings.
- Mechanical packing preserves alpha and proportions. Four tightly spaced source crops trim minor low-alpha fur/whisker pixels; no opaque anatomy is clipped.
- Idle silhouettes are 391px high for Archie and 389px for Jumi, meeting the 384px source-detail target. Sprite frames are 512×512.
- Action pages decode to 2–4 MiB each. Two cached pages per kitten use 12–16 MiB in total, excluding other app allocations.

Source sheets, crop metadata, the local packing script and the generation prompts are included in the source archive. `npm run art` repacks those assets locally; it does not call an image service. The earlier vector generator is retained only as an explicitly named legacy tool.

### Install or develop

Run `ArchieJumiSetup.exe` for the updated personal Windows build. It uses the same application identity as 1.0.0. The installer remains unsigned. This task built and tested the packaged executable but did not install it into your account.

For source development, extract `archie-and-jumi-source.zip`, open `archie-jumi-app`, and run `npm ci` then `npm start` with Node.js 24 LTS on Windows x64. Dependency installation needs network access; normal app operation does not.

Sound and launch at login are off initially. Closing Settings leaves the pets and tray running. Use the tray to Quit, or Ctrl+Alt+Shift+P to hide/show them. Change the shortcut in Settings if it conflicts with another app.

### Validation and resource use

TypeScript, all **103 automated tests**, browser UI checks and the final packaged native smoke assertions passed. The native test checked alpha-hit input mode, drag capture/release, stationary-pointer encounters, Quiet Mode, hide/show, all three monitor selections and recovery after an intentional renderer crash. See `VALIDATION.md` for scope.

A short native benchmark on this Windows 11 / Ryzen 5 5500U machine, with Settings closed, measured:

| State | Average total-system CPU | Average combined working set |
| --- | ---: | ---: |
| Resting/sleeping | 0.49% | 373 MiB |
| Automatic yarn play | 1.59% | 398 MiB |
| Hidden | 0.03% | 402 MiB |

Play rendered at approximately 30 FPS; hidden mode produced zero sprite draws. Each phase lasted about five seconds. Working-set sums can count shared memory more than once. These are measurements on this machine, not performance guarantees. The separate capture-heavy native test with Settings open reached about 588 MiB, so the 500 MiB target is not established for every condition.

### Remaining acceptance work

Physical mouse passthrough, typing focus, monitor unplug/reconnect, power/lock/fullscreen behavior, 100% and 200% native DPI checks, clean-account installation/upgrade/uninstall and long-duration resource testing remain to be performed. GPU usage and input latency were not measured.

One 150% monitor reports an overlay height three DIP taller than its work area. The scene uses the work-area geometry and empty space is click-through; the native discrepancy remains open for physical testing.

Further animation work can add in-between frames and separate left-facing art while retaining these realistic character identities. The full original V1 acceptance gate has not been certified.
