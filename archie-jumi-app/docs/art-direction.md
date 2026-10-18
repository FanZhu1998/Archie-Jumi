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

`scripts/pack-realistic-art.mjs` preserves supplied alpha, extracts each pose, trims transparent padding, scales without stretching, and places the opaque lower edge at the ground anchor. Poses of a kitten share one scale after normalization for source-sheet resolution. Wide or tall poses can constrain that scale; the packing report states size compromises. Generated camera framing can still cause differences that packing cannot repair.

The optional `artwork/realistic/crops.json` supplies integer `left`, `top`, `width` and `height` rectangles by sheet filename and pose name. These mechanically follow transparent gaps when a generated pose crosses a nominal grid line. Crop height does not alter scale normalization: the original half-sheet height remains the reference. Source sheets are never rewritten.

## Pack and renderer contract

- Packs live at `public/pets/{id}/manifest.json`, with `atlas.png` and action pages relative to that manifest. They retain the existing `AnimationPack` version 1 contract.
- Default frames are **512×512**, with ground anchor **(256,464)**. Coordinates and hit shapes are frame pixels; durations are milliseconds.
- Every action has left and right entries. Supplied right-facing art is mirrored for the left-facing fallback, including asymmetric markings. Separate left-facing artwork is needed to remove that limitation.
- Idle alternates open eyes and blinking. Walking and trotting use their supplied two-pose cycles. The other ten actions hold a single semantically correct pose; they are not fully animated multi-frame clips. Future in-between artwork can extend them without changing behavior names.
- The full compatibility atlas is **2048×6656**, approximately **52 MiB decoded per kitten**. Four columns accommodate two poses per direction; shorter rows retain transparent unused space.
- Idle, walk and trot pages are **2048×512** (4 MiB decoded). Single-pose pages are **1024×512** (2 MiB decoded). Caching idle plus one active action per kitten uses **12–16 MiB total**, before renderer overhead.
- Frame coordinates remain relative to the full atlas. The renderer subtracts page offsets when sampling a lazy-loaded page. The full atlas remains a fallback for legacy readers and tooling.
- Hearts, lettering, treats and toys remain separate app effects. Alpha masks provide precise click-through; static hit ellipses are only a coarse fallback.

## Quality and validation

Packing preflights all eight sources before overwriting either kitten. Every crop must contain useful opaque artwork and actual transparency. Opaque pixels at the two-pixel crop boundary stop packing because clipped anatomy cannot be repaired mechanically; faint edge pixels produce a review warning. Alpha trimming retains a feather margin and preserves remaining alpha values.

The target idle silhouette is **430 pixels tall**, enough for 192 DIP at 200% scaling when source framing permits. A common-scale fit may reduce that target to preserve wider or taller actions. `work/realistic-packing-report.json` records actual silhouette size, uniform scale, source crops, output bounds and warnings. Lower-resolution exports use `npm run art -- --frame-size=256` or `--frame-size=384` and soften sooner at large display settings.

Review `work/realistic-animation-preview.png` for likeness, consistent body scale and correct pose selection. Review `work/realistic-pair-preview.png` for actual muzzle contact at engine spacing; a generated nose-touch pose does not guarantee aligned noses. Check light and dark backgrounds for fur halos. Every generated frame and page is checked for nonempty content, safe bounds and renderer-compatible coordinates.

The original cartoon/vector generator remains at `scripts/generate-art-legacy-vector.mjs` for reference. It is disabled unless explicitly called with `--replace-current-art`, because it replaces current packs with the cartoon style. `npm run art` always uses realistic packing. Portrait PNGs and application icons are not rewritten by this pipeline.
