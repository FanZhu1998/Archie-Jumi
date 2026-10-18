# Archie & Jumi — validation record

Build: **1.0.1**, Windows x64. Checked October 17, 2026.

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
