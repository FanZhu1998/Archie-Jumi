# Archie & Jumi — realistic appearance update

Version **1.0.1** · Windows 11 x64 · October 17, 2026

## What changed

The profile cards, desktop kitten sprites and application icon now use realistic artwork based on the supplied photos. Archie retains his gray tabby coat, white facial blaze, muzzle, chest and paws. Jumi retains the orange tabby coat, cream muzzle and light paw tips.

The profile cards use static transparent portraits with neutral backgrounds. Cartoon drawings, decorative sparkles and the cartoon fallback have been removed. Both desktop kittens use matching realistic pose packs for all thirteen existing actions. Petting, dragging, treats, yarn play, naps, shared activities, Quiet Mode and saved settings remain available.

The artwork was created with the built-in imagegen tool using the supplied photographs. It is a generated interpretation, not an unchanged photograph. Unseen markings and body details are reconstructed. The original photos are not bundled, and the installed app operates offline without uploading images.

## Artwork details and limits

- Sixteen supplied poses per kitten, mapped to thirteen actions in both directions.
- Idle/blinking, walking and trotting use multiple poses. The other ten actions hold a distinct pose; they are not fully animated multi-frame sequences.
- Left-facing versions currently mirror the supplied right-facing artwork. Separate left-side references would improve asymmetric markings.
- Mechanical packing preserves alpha and proportions. Four tightly spaced source crops trim minor low-alpha fur/whisker pixels; no opaque anatomy is clipped.
- Idle silhouettes are 391px high for Archie and 389px for Jumi, meeting the 384px source-detail target. Sprite frames are 512×512.
- Action pages decode to 2–4 MiB each. Two cached pages per kitten use 12–16 MiB in total, excluding other app allocations.

Source sheets, crop metadata, the local packing script and the generation prompts are included in the source archive. `npm run art` repacks those assets locally; it does not call an image service. The earlier vector generator is retained only as an explicitly named legacy tool.

## Install or develop

Run `ArchieJumiSetup.exe` for the updated personal Windows build. It uses the same application identity as 1.0.0. The installer remains unsigned. This task built and tested the packaged executable but did not install it into your account.

For source development, extract `archie-and-jumi-source.zip`, open `archie-jumi-app`, and run `npm ci` then `npm start` with Node.js 24 LTS on Windows x64. Dependency installation needs network access; normal app operation does not.

Sound and launch at login are off initially. Closing Settings leaves the pets and tray running. Use the tray to Quit, or Ctrl+Alt+Shift+P to hide/show them. Change the shortcut in Settings if it conflicts with another app.

## Validation and resource use

TypeScript, all **103 automated tests**, browser UI checks and the final packaged native smoke assertions passed. The native test checked alpha-hit input mode, drag capture/release, stationary-pointer encounters, Quiet Mode, hide/show, all three monitor selections and recovery after an intentional renderer crash. See `VALIDATION.md` for scope.

A short native benchmark on this Windows 11 / Ryzen 5 5500U machine, with Settings closed, measured:

| State | Average total-system CPU | Average combined working set |
| --- | ---: | ---: |
| Resting/sleeping | 0.49% | 373 MiB |
| Automatic yarn play | 1.59% | 398 MiB |
| Hidden | 0.03% | 402 MiB |

Play rendered at approximately 30 FPS; hidden mode produced zero sprite draws. Each phase lasted about five seconds. Working-set sums can count shared memory more than once. These are measurements on this machine, not performance guarantees. The separate capture-heavy native test with Settings open reached about 588 MiB, so the 500 MiB target is not established for every condition.

## Remaining acceptance work

Physical mouse passthrough, typing focus, monitor unplug/reconnect, power/lock/fullscreen behavior, 100% and 200% native DPI checks, clean-account installation/upgrade/uninstall and long-duration resource testing remain to be performed. GPU usage and input latency were not measured.

One 150% monitor reports an overlay height three DIP taller than its work area. The scene uses the work-area geometry and empty space is click-through; the native discrepancy remains open for physical testing.

Further animation work can add in-between frames and separate left-facing art while retaining these realistic character identities. The full original V1 acceptance gate has not been certified.
