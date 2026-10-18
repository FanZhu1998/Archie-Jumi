# Archie & Jumi — validation record

## Build 1.0.2

Windows x64, from source on the development PC. Checked October 18, 2026.

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Automated tests | 256 passed in 17 files |
| Browser UI | Passed in Chrome and Edge: portraits, rename and reload, keyboard slider, play, reposition, Quiet Mode, visibility, sound, reduced motion, live playground, narrow layout, no page errors |
| Native smoke | All 37 required checks passed in repeated runs |
| Native benchmark | Resting 0.60%, play 1.84%, hidden 0.10% of total CPU; 342–365 MiB combined working set; zero sprite draws while hidden |
| Root-cause experiment | Not reproduced; see below |
| Windows installer build | Not rebuilt for 1.0.2 |

The native smoke test runs the app with an isolated profile and drives the cursor feed with a scripted cursor, so the real mouse cannot affect results. Beyond the fifteen 1.0.1 checks, it covers:

- hover through the cursor feed, worst-case hover latency (17–21 ms over three runs, limit 100 ms) and hover exit
- the hover guard against a stale report, the heartbeat resync, and a real pointer that must not override the scripted one
- drag capture, drag movement and the missed-release guard
- lock and unlock, hybrid routing with hook re-arming, and the default polling routing
- a display event without metric changes (no rebuild) and one with changes (rebuild with a scene handoff)
- a starved frame loop that keeps animating on timers and stops the fallback when frames return
- automatic recovery from a hung scene, a renderer crash and a lost graphics process, the recovery budget, teardown of a hung scene, and Show All
- Copy diagnostics restricted to the Settings window, with honest feedback when the clipboard is busy

All three monitors initialized. On the right 150% monitor the overlay is 1200 × 2089 DIP against a 1200 × 2086 work area; this known discrepancy is now written to the diagnostics log.

### Root-cause experiment

The plan expected Windows to silently remove Electron's mouse-forwarding hook after a stalled main thread. Two native probes on Windows 11 build 26200 with Electron 44.8 tested that with real 1-pixel cursor moves, which restore the cursor afterwards and never click. Forwarding kept working after every one of these:

- main-thread stalls of 2.5 s and 6 s, and twelve stalls of 1.2 s
- hiding and showing the overlay
- destroying and recreating the overlay
- a killed and restarted GPU process

The same run confirmed that re-arming forwarding works and that polling detects the real cursor without any hook. The trigger behind the reported bug remains unknown; 1.0.2's default polling routing does not depend on forwarding at all.

### Not covered

Physical mouse behavior, real lock, unlock and sleep cycles, monitor unplug and reconnect, 100% and 200% scaling, a long soak, GPU utilization, and installation or upgrade were not tested for 1.0.2.

## Build 1.0.1

Windows x64. Checked October 17, 2026.

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Automated tests | 103 passed in seven files |
| Browser UI | Passed with decoded realistic PNG portraits; no page errors; keyboard controls, persistence, hidden/quiet states and narrow layout exercised |
| Realistic asset packing | 32 source poses, 64 directional sprite frames and 26 action pages packed with alpha/bounds validation |
| Visual review | Portraits, cream/dark contact sheets and paired nose-touch poses inspected |
| Windows installer build | Passed |
| Packaged native smoke | All fifteen required assertions passed |
| ASAR contents | Version 1.0.1, two portrait PNGs, 26 action pages, no old portrait SVGs or temporary/test/source-art directories |

The packaged native assertions cover renderer startup, Node isolation, non-focusable configuration, pet-pixel input mode, pointer capture/release, empty-space mode, stationary cursor entry/exit, Quiet Mode, hide/restore, renderer-crash hiding/recovery and saving.

All three selected monitors initialized. Primary 125% and left 150% bounds matched their work areas; the right 150% monitor returned a window three DIP taller. This discrepancy remains unresolved.

Native tests inject pointer events through Electron and examine the resulting native input state. They do not prove physical mouse passthrough or hardware lifecycle behavior. The test used an isolated profile and captured only app-owned windows. It did not install the app or change Windows startup registration.

The new short resource benchmark measured approximately 373 MiB at rest and 398 MiB during play with Settings closed, about 30 FPS during play and zero hidden sprite draws. A capture-heavy packaged test with Settings open reached approximately 588 MiB. GPU utilization, measured input latency and a long-duration soak remain untested. Sanitized results are in source `docs/performance-results.json`.

Art limits are recorded in `docs/art-direction.md`: mirrored left-facing poses, ten single-pose actions, and minor low-alpha fine-edge cropping in four source regions. Original photos are not included in either the installer or source archive. See `RELEASE-NOTES.md` for remaining acceptance work.
