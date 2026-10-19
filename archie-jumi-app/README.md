# Archie & Jumi

An offline Windows desktop companion app with realistic, photo-based versions of gray-and-white Archie and orange tabby Jumi.

## Run from source

Use Node.js 24 LTS on Windows x64. Dependencies are pinned in `package-lock.json`.

```powershell
npm ci
npm start
```

If npm asks about build scripts, approve the installed Electron/build-tool scripts before building. `npm start` builds the app and opens the desktop companions and their control panel.

## Controls

- Click a kitten for a short pet. Press and hold without moving (about a third of a second) for a longer pet: hearts keep rising and, with Little sounds on, a soft purr loops until you let go, for up to 8 seconds.
- Drag more than six logical pixels to carry a kitten and put it down somewhere else. It swings a little with the drag, its shadow stays on the ground, and it lands with a small squash and a puff of dust. A drag that starts after a hold is still a drag.
- Right-click a kitten, or open its submenu in the tray, for Come here, treats, yarn, naps, waking and hiding:
  - **Come here** walks the kitten to a spot you point at, and it sits there for a while. From a kitten's own menu, choose it, then move the pointer to the spot and hold it still for a moment (within six seconds). From the tray, the kitten walks to where the pointer last rested on the desktop before you went to the tray.
  - **Give a treat** drops a treat just ahead of the kitten. It bounces once, the kitten walks over and eats it, and a few crumbs are left for a moment.
  - **Play with yarn** puts the ball in front of the kitten, which chases it, crouches and pounces. You can pick the ball up and move it; when you let go it bounces. In **Automatic yarn play** the ball rolls between random spots near where play started, and a pounce can bat it away.
- **Curious about the cursor** (on by default, in Settings under Your calm corner): rest the cursor near an idle, sitting or grooming kitten for about two and a half seconds and it turns to look. Sometimes it wanders over and sits next to it. Each kitten then ignores the cursor for a minute and a half to three minutes. Curiosity never makes the window catch clicks: away from the kittens themselves, clicks still reach the apps underneath.
- The personality sliders shape all of this: playful kittens pounce, bat the yarn and trot more often and are more likely to wander over to the cursor; sociable ones seek each other out more and also wander over to the cursor more; energetic ones wander more, sleep less and walk faster.
- Use the tray menu or Ctrl+Alt+Shift+P to hide/show all companions.
- Quiet Mode moves the kittens near the bottom and makes the complete overlay click-through; nothing new happens while it is on.
- Gentler motion keeps the kittens from roaming or leaping and turns off the procedural motion (breathing, walking bob and lean, turns, squash and stretch, crossfades) and the particles; feedback stays as simple static glyphs. Treats appear right at the kitten's paws, and Come here moves the kitten at once.
- The control panel offers keyboard-accessible actions, automatic yarn play and directional reposition buttons.
- Sound and launch at login are off initially. Login launch is available only in the installed app.

Both kittens stay on the selected monitor. The app does not inspect windows, take desktop screenshots, record keyboard input or access online services during ordinary use. Cursor curiosity uses the cursor position only near the kittens and only in memory; it is never saved or sent anywhere. The developer smoke test captures only the app's own windows when explicitly invoked.

## Troubleshooting

- **Copy diagnostics** (Settings → A place on your desktop) copies a short local log to the clipboard for a bug report: versions, input routing, display count and scale factors, and recent input and recovery events. The log is kept locally as `diagnostics.log` (plus one older `diagnostics.1.log`) in the app's data folder; nothing is sent anywhere. If another program is holding the clipboard, the app says so instead of copying; try again.
- The app finds the cursor by polling it, without a global mouse hook. If hover ever misbehaves, start it with `--input-routing=hybrid` to add Windows mouse forwarding as well; the app re-arms it automatically.
  1. Quit Archie & Jumi from the tray first. Starting it again while it runs only opens Settings and keeps the current mode.
  2. From source: `npm start -- --input-routing=hybrid`. Installed app: run `"%LocalAppData%\archie_jumi\archie-jumi.exe" --input-routing=hybrid` (for example from Win+R), or append ` --input-routing=hybrid` to the Target of the Start-menu shortcut, which points at that file.
  3. Copy diagnostics then shows `input routing hybrid`. Launch at login starts without the flag, and installing or upgrading recreates the shortcut without it.
- Chromium's native window occlusion tracking is off so covered kittens keep animating. `--native-occlusion`, passed the same way after quitting from the tray, turns it back on; Copy diagnostics then shows `native occlusion enabled`.

## Development and checks

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
npm run make
```

`npm run preview` serves a browser-only control-panel preview. It cannot implement native click-through or tray controls. Open `?view=overlay` on the preview server to inspect animations; preview tabs share local preferences and commands.

`npm run screenshots` regenerates the README images in `docs/screenshots/`. It runs the app with a fresh temporary profile, poses the kittens, and captures only the app's own windows; the kittens are drawn on a neutral background, and monitor names are replaced with generic labels.

`npm run smoke` uses an isolated local test profile, captures the app's own windows and writes a report to `test-results/`. It drives hover with a scripted cursor and also checks hold-to-pet, Come here, the treat flow, cursor curiosity and the curious toggle, and hover on a walking, turning kitten. For visual review it saves `motion-play.png`, `motion-pounce.png`, `motion-treat.png` and `motion-held-pet.png` next to the report. It does not certify all monitor, full-screen, DPI, real-pointer or installation scenarios.

`node tests/ui-browser.ts` runs the control panel and the browser playground in a headless browser (Chrome by default; set `UI_TEST_BROWSER=msedge` to use Edge). It covers the settings, including the curious toggle, and a real-mouse hold-to-pet in the playground.

The Windows installer is produced under `out/make/squirrel.windows/x64/`. It is a personal unsigned build, with manual updates. Signing and automatic updates are future distribution work.

## Architecture

- `src/core`: deterministic behavior engine, pointer gestures (click, hold, drag), procedural motion poses and analytic particle effects; independent of Electron and the DOM.
- `src/rendering`: Canvas scene, sprite validation and alpha hit masks (exact under the motion transforms), effects layers, hold-to-pet wiring and the synthesized optional purr (one-shot for a click, a loop for a hold).
- `src/main`: native windows, tray, validated IPC, lifecycle recovery and versioned atomic storage.
- `src/shared`: contracts, defaults and validation.
- `src/ui`: accessible React control panel.
- `public/pets`: media-only animation packs.
- `scripts/generate-art.mjs`: local mechanical packing of the supplied realistic pose sheets; does not upload photos.
- `artwork/realistic`: generated pose sources and crop metadata for rebuilding the character packs.

State is stored in Electron's per-user app-data directory as `state.json`, with a previous-good backup. Unsupported future-schema files are preserved without overwriting. A version-zero fixture demonstrates migration handling; there is no earlier publicly released app.

## Character assets

Version 1.0.1 replaces the illustrated portraits and desktop sprites with realistic artwork generated from the supplied photos using the built-in imagegen tool. Each kitten has 16 source poses mapped to 13 semantic actions. Idle/blinking, walking and trotting use multiple poses; the remaining actions use distinct still poses. Left-facing sprites are mirrored versions, with that limitation documented. These are generated interpretations, not unchanged photographs.

The supplied 512px sprite cells retain transparency and load through bounded action-page caches. `npm run art` rebuilds the packs from the included source sheets without online services; it does not regenerate artwork. The earlier vector generator is retained only as an explicitly named legacy authoring tool. See `docs/art-direction.md` and `docs/realistic-art-prompts.md` for the production record and likeness limits.

## Manual release acceptance

Before treating a build as fully validated on another machine, check empty-space click/scroll/drag propagation, fast entry, stationary cursor with moving pets, focus during petting, monitor unplug/reconnect, mixed DPI, lock/suspend/resume, fullscreen return, renderer recovery, installation, upgrade and uninstall. Check the accompanying release notes for checks actually performed on this build.
