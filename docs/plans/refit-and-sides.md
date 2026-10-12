# The garment always on the real body, and smooth sides (2026-10-12)

Asked: "the re-fitting should always dress the garment on the person's real body - when they turn 90 degrees the engine must
not guess whether they have a belly, it must see it and dress it; then the sides: no jump when the image changes. Main stays as
it is; all of it on a branch; measure it yourself, no frame out of place."

Branches: `refit` (from preview-oct8 73e2084) -> `sides` (from `refit`). `main` is not touched. Everything new runs in TEST
sessions only (store key TEST) until the owner measures it.

## Measured first (free - the rig's existing sessions, `scratchpad/fid/fidelity.mjs`)
Every output frame and the camera frame it renders (best match within +-150ms of the session's measured delay), both
segmented by the room's own pose model; silhouette IoU and the body's depth at chest / belly / hips in torso heights.

| session | square-on IoU | side IoU | side belly out/in | side chest out/in |
|---|---|---|---|---|
| c2 shorts (own top kept) | 0.92 | 0.94 | 1.01 | 0.99 |
| b2 shorts | 0.92 | 0.90 | 1.01 | 0.99 |
| c1 shirt (PEAK) | 0.95 | 0.91 | 1.14 | 1.04 |
| c5 shirt (PEAK) | 0.95 | 0.93 | 1.10 | 1.07 |

The engine follows the body well; side-on with a new top the belly comes out 10-14% deeper (part of it the PEAK tee's boxy cut).
**Why it has to guess at all:** the render model works at 1088x624 (`@decartai/sdk` model table) and the room sends it the camera
at 512x288 - and on a desktop the camera itself is asked for 512x288. A full-length shopper arrives ~160px tall, the belly
side-on ~15px, upscaled 2.1x.

## Part 1 - refit: the engine sees the body (branch `refit`)
- [ ] R1 render input 896x504 (camera asked for 1280x720 on desktop), TEST sessions only, `?hi_input=0` off. Measured alone this
      time - 30a7710 shipped it together with a reference crop and the pair was reverted (the crop made fragment references,
      which the engine draws into the room - §2.46).
- [ ] R2 the rig: camera at 1280x720 (it painted 640x360), the publisher's uplink read every second (send rate, frame size,
      quality limitation, available bitrate) - the 20fps lesson: a full uplink delays the back reference.
- [ ] R3 gates: unit, trace:prompt identical, qa:visual, build; the default (shopper) path byte-identical.
- [ ] R4 measure (billed): shirt + shorts at 896x504 - fidelity (side IoU, belly ratio), every frame front/back, swap acks,
      output fps, stalls, uplink. Keep only if fidelity improves and nothing in the turn gets worse.
- [ ] R5 if the side is still guessed: a side-only prompt-free lever (none chosen yet - measure R1 first).

## Part 2 - sides: no jump when the image changes (branch `sides`)
- [ ] S1 "twin" references: the back image built to match the front - the same canvas, the garment at the same scale and
      place, the back's colours matched to the front's (mean/std per channel inside the garment). Never cut to a fragment
      (fragments are drawn into the room).
- [ ] S2 the colour in words: check what colour each garment's prompt carries (the shorts rendered red, the product is black).
- [ ] S3 the jump, measured: the garment region's colour in the frames before and after a swap lands, against the frame-to-frame
      noise elsewhere; and the front's colour at the end against the start (the PEAK tee came back black).
- [ ] S4 gates as R3; measure (billed): shirt, shorts, full look - every frame, the jump number, the swaps.
- [ ] S5 (bigger, only if needed) a side bridge image.
