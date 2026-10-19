# Archie & Jumi — realistic artwork and sprite packing

**Archie is the gray-and-white kitten; Jumi is the orange kitten.** The realistic artwork is derived from the supplied reference photographs. Archie keeps a white blaze, muzzle, chest and paws; Jumi keeps an orange tabby coat, pale muzzle and light paws. Generated unseen markings and pose details remain artistic interpretations. Editable personality presets are fictional creative defaults, not claims about the real cats.

## Source artwork and privacy

The realistic portraits and sprite sheets were generated before packing. The app itself is offline and ships with finished image assets. Original photographs are not copied into the sprite packs. `npm run art` performs local mechanical processing with Sharp; it does not call an image service, read the original photographs, paint pixels, invent anatomy, or replace the separately supplied `portrait.png` files.

Source sheets live at `artwork/realistic/{archie,jumi}-{a,b,c,d}.png`. Each contains four poses arranged left-to-right, top-to-bottom:

| Sheet | Top left | Top right | Bottom left | Bottom right |
| --- | --- | --- | --- | --- |
| A | Idle | Blink | Walk A | Walk B |
| B | Groom | Sleep | Wake | Pet |
| C | Carried | Land | Pounce | Eat |
| D | Nose touch | Trot A | Trot B | Sit |

Optional sheets `{archie,jumi}-{e,f,g,h}.png` add in-between and true left-facing poses; see [Optional sheets E–H](#optional-sheets-eh).

`scripts/pack-realistic-art.mjs` preserves supplied alpha, extracts each pose, trims transparent padding, scales without stretching, and places the opaque lower edge at the ground anchor. Poses of a kitten share one scale after normalization for source-sheet resolution. Wide or tall poses can constrain that scale; the packing report states size compromises. Generated camera framing can still cause differences that packing cannot repair.

The optional `artwork/realistic/crops.json` supplies integer `left`, `top`, `width` and `height` rectangles by sheet filename and pose name, for optional sheets as for A–D. These mechanically follow transparent gaps when a generated pose crosses a nominal grid line. Crop height does not alter scale normalization: the original half-sheet height remains the reference. Sheet and pose names are checked, so a misspelled entry stops packing instead of silently falling back to the grid cell. Source sheets are never rewritten. With another source folder (`--source-dir=`), a sheet that is a byte-identical copy of a bundled one keeps the rectangles in `artwork/realistic/crops.json` unless the folder's own `crops.json` lists that sheet; packing prints which sheets do. A changed sheet needs its own rectangles.

## Optional sheets E–H

Sheets E–H use the same 2×2 row-major layout, checks and crop overrides as A–D. E, F and G face right like A–D; **H is drawn facing left**. Each sheet is used only when its file exists, separately for each kitten, and changes only the clips listed below. A kitten without optional sheets is packed exactly as before: its manifest, action pages and atlas are byte-identical to the A–D-only packs. Prompts and review steps are in `docs/phase3-art-prompts.md`.

| Sheet | Top left | Top right | Bottom left | Bottom right |
| --- | --- | --- | --- | --- |
| E | Walk C (`walk_c`) | Walk D (`walk_d`) | Sleep B, breath in (`sleep_b`) | Eat B, chew (`eat_b`) |
| F | Pounce crouch (`pounce_crouch`) | Pounce air (`pounce_air`) | Pounce land (`pounce_land`) | Groom B (`groom_b`) |
| G | Trot C (`trot_c`) | Trot D (`trot_d`) | Pet B, leaning into the hand (`pet_b`) | Wake B (`wake_b`) |
| H (faces left) | Idle left (`idle_left`) | Blink left (`blink_left`) | Sit left (`sit_left`) | Sleep left (`sleep_left`) |

Clip changes, durations in milliseconds; loop flags stay as before:

| Clip | A–D only | With the optional sheet |
| --- | --- | --- |
| walk | walk_a, walk_b · 160, 160 | **E**: walk_a, walk_c, walk_b, walk_d · 80 each (the 320 ms stride cycle is unchanged) |
| trot | trot_a, trot_b · 105, 105 | **G**: trot_a, trot_c, trot_b, trot_d · 52.5 each (the 210 ms cycle is unchanged) |
| sleep | sleep · 2000 | **E**: sleep, sleep_b · 1700, 1700 (one slow breath per 3.4 s, the motion layer's breathing cycle) |
| eat | eat · 1500 | **E**: eat, eat_b · 250, 250 (chewing with the motion layer's 2 Hz bob) |
| pounce | pounce · 650, once | **F**: pounce, pounce_crouch, pounce_air, pounce_land · 100, 100, 300, 150, once (the engine's 0.2 s crouch, then its 0.45 s leap) |
| groom | groom · 1300 | **F**: groom, groom_b · 600, 600 (the motion layer's 1.2 s head tilt) |
| pet | pet · 1700 | **G**: pet, pet_b · 500, 500 (the motion layer's 1 Hz nuzzle) |
| wake | wake · 1100, once | **G**: wake, wake_b · 550, 550, once (the engine's 1.1 s stretch) |
| idle, sit, sleep (left-facing) | mirrored right-facing art | **H**: idle_left and blink_left; sit_left; sleep_left |

The renderer speed-matches walk and trot: one clip cycle always covers one stride of two steps, however many frames it has, so in-betweens smooth the stride without changing its pace. Airborne and landing poses need no headroom; packing aligns every pose's lowest opaque pixel with the ground line and the app supplies the leap height.

**True-left frames.** A clip uses true-left art only when every one of its poses has a true-left variant; true-left and mirrored frames are never mixed in one clip. With sheets E and H together, the two-pose sleep clip has no true-left `sleep_b`, so the whole left-facing sleep clip stays mirrored and packing warns that `sleep_left` is unused. True-left frames are centered on the anchor and grounded like every other pose. The manifest attribution names the actions that use true-left art.

**Scale.** Optional poses share the kitten's common scale. A wider or taller optional pose lowers it for every frame of that kitten; packing then names the pose and prints both the A–D-only scale and the new one, and the report records them as `scaleFromSheetsAtoD` and `commonScale`.

**Budgets.** At most **4 frames per clip and direction**, so an atlas row holds at most 8 frames (4096 px at 512 px frames) and the 13-row atlas stays within the renderer's **30,000,000-pixel** decoded-image budget (4096 × 6656 = 27,262,976 pixels). Packing stops with a clear message if a clip table change would exceed either limit; supplied art alone cannot.

## Pack and renderer contract

- Packs live at `public/pets/{id}/manifest.json`, with `atlas.png` and action pages relative to that manifest. They retain the existing `AnimationPack` version 1 contract; optional sheets add frames, not fields.
- Default frames are **512×512**, with ground anchor **(256,464)**. Coordinates and hit shapes are frame pixels; durations are milliseconds.
- Every action has left and right entries with the same frame count and durations. Supplied right-facing art is mirrored for the left-facing fallback, including asymmetric markings, except in clips that sheet H covers completely (idle and sit, and sleep without sheet E).
- Idle alternates open eyes and blinking. Walking and trotting use their supplied two-pose cycles, or four poses with sheets E and G. The other actions hold a single semantically correct pose unless sheets E–G add a second pose (sleep, eat, groom, pet, wake) or the four-pose pounce. A manifest freely mixes one-pose and multi-pose clips, and behavior names never change.
- The full compatibility atlas is **2048×6656**, approximately **52 MiB decoded per kitten**, or **4096×6656** (104 MiB decoded) once any clip has four poses. Each row holds the right-facing frames, then the left-facing frames; shorter rows retain transparent unused space.
- Action pages are **1024×512** (2 MiB decoded) for one pose per direction, **2048×512** (4 MiB) for two and **4096×512** (8 MiB) for four. With the renderer keeping idle plus the two most recent action pages per kitten, the decoded page cache stays at most 12 MiB per kitten (24 MiB total) with A–D only, and at most 20 MiB per kitten (40 MiB total) with four-pose walk, trot or pounce clips, before renderer overhead.
- Frame coordinates remain relative to the full atlas. The renderer subtracts page offsets when sampling a lazy-loaded page. The full atlas remains a fallback for legacy readers and tooling.
- Hearts, lettering, treats and toys remain separate app effects. Alpha masks provide precise click-through; static hit ellipses are only a coarse fallback.

## Packing commands

- `npm run art` packs `artwork/realistic/` into `public/pets/` and writes review files to `work/`.
- `npm run art -- --check` validates every sheet and prints the report (optional sheets found, clip changes, common scale, atlas and page sizes, warnings) without writing anything.
- `--source-dir=`, `--output-dir=` and `--work-dir=` point packing elsewhere, for example `npm run art -- --source-dir=work/new-art --output-dir=work/staging/pets --work-dir=work/staging` to review new sheets without touching the app's packs. A source folder always needs all eight A–D sheets; unchanged copies of them need no `crops.json` (see above).
- `--frame-size=256` or `--frame-size=384` exports lower-resolution packs (see below). Unknown options are rejected; `--help` lists them.

## Quality and validation

Packing preflights all eight required sources, and any optional sheets, and builds the review images before it writes anything. It then writes every new pack file beside its target (`*.pack-new`), checks that every existing target can be replaced (read-only files and most locked files stop packing here), and swaps both kittens' files in, each `manifest.json` last. If any step fails, the swap is undone, so the previous packs stay complete and a manifest is never left beside pages of another layout. A run interrupted during the swap (for example by Ctrl+C) leaves that kitten without `manifest.json`, which fails loudly; the next run first restores the previous pack from its `*.pack-old` backups. Every crop must contain useful opaque artwork and actual transparency. Opaque pixels at the two-pixel crop boundary stop packing because clipped anatomy cannot be repaired mechanically; faint edge pixels produce a review warning. Alpha trimming retains a feather margin and preserves remaining alpha values. Source-folder files that look like sheets but are not named exactly as one (wrong letter or capitalization) produce a notice.

The target idle silhouette is **430 pixels tall**, enough for 192 DIP at 200% scaling when source framing permits. A common-scale fit may reduce that target to preserve wider or taller actions. `work/realistic-packing-report.json` records actual silhouette size, uniform scale, source crops, output bounds and warnings; with optional sheets it also lists the sheets used, every clip with its poses, durations and left-facing art, and the A–D-only scale. Lower-resolution exports use `npm run art -- --frame-size=256` or `--frame-size=384` and soften sooner at large display settings.

Review `work/realistic-animation-preview.png` for likeness, consistent body scale and correct pose selection. Review `work/realistic-clip-preview.png` and `work/realistic-clip-preview-dark.png` for every frame of every clip in playing order, right-facing then left-facing, labelled mirrored or true left, with a line at the ground anchor: new in-betweens must keep the identity, body size and ground contact of their neighbours, and true-left frames must show the markings on the correct side. Review `work/realistic-pair-preview.png` for actual muzzle contact at engine spacing; a generated nose-touch pose does not guarantee aligned noses. Check light and dark backgrounds for fur halos. Every generated frame and page is checked for nonempty content, safe bounds and renderer-compatible coordinates.

The original cartoon/vector generator remains at `scripts/generate-art-legacy-vector.mjs` for reference. It is disabled unless explicitly called with `--replace-current-art`, because it replaces current packs with the cartoon style. `npm run art` always uses realistic packing. Portrait PNGs and application icons are not rewritten by this pipeline.
