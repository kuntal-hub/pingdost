# 0048 — Premium camera effects, head roll, a movable self view

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** none (after Phase 40; follows Phase 33, ADR 0038)
- **Approved by user:** n.a. (the user asked for it; no new dependency)

## Context
The user, after using ADR 0038's effects:
- The dog and cat filters looked like flat stickers on the video, "cheap and poor". They wanted lenses like Instagram's and Snapchat's.
- Beauty was too basic.
- Big eyes was "very good", but there was only one fun face effect. They wanted more.
- The small self view in the bottom-right corner of a video call should be movable.

Limits: ADR 0038 still holds. The only face tracker is Android's `FaceDetector` (eye midpoint and distance; its pose is always 0). The web has no tracker. There is no money for assets, and no new library.

## Options considered
| Option | Pros | Cons | License | Cost |
|---|---|---|---|---|
| **Shaded, animated procedural lenses in the shared GLSL catalog** (bevelled normals, light, fur, metal, soft shadows, glow) | JS-only update; same source on both apps; no assets to license | Still no landmarks: nothing reacts to the mouth | none new | 0 |
| Image-based lens assets (PNG ears, glasses) | Photographic look | Need artists or licensed art; flat without tracking of roll and depth | varies | money or time |
| Face mesh (468 points) via TFLite / TF.js and MediaPipe models | Landmarks, roll, mouth open, lenses on the web | New runtime and models (≈3–4 MB APK, ≈2–3 MB web download); MediaPipe Tasks telemetry (ADR 0038) must be avoided; a large job | Apache-2.0 | 0 |
| **Roll from the eye line on the detector's own output** | Lenses tilt with the head; pure Kotlin, JVM-testable, ≈10k pixel reads per detection | Heuristic: unsure frames fall back to the last angle | none | 0 |

## Decision
- **Catalog** (`packages/call-engine/src/effects.ts`): 54 effects in four groups. `EFFECT_GROUPS`; each effect has an `icon` (a Lucide name both apps map) and `tracksFace`. That flag runs the tracker for beauty too: `face` still means "needs it".
  - **Beauty (6, phone and web):** Natural, Glam, Glow, Porcelain, Bronze, Soft focus.
    - Bilateral skin smoothing (14 taps, radius from the face size), a YCbCr skin mask, and detail kept off the skin.
    - Tone, glow and grading per look.
    - Where a face is tracked: slimmer cheeks and jaw, slightly larger eyes, lighter under-eyes, blush.
  - **Lenses (12, phone):** Puppy, Kitty, Bunny, Teddy, Aviators, Hearts, Flower crown, Halo, Devil, Crown, Freckles, Glitter.
    - Drawn as signed-distance shapes with bevelled normals, light and specular, fur strands with soft edges, tube-shaded metal, and soft shadows on the face.
    - Some move: ears wiggle, hearts orbit, sparkles twinkle, glints sweep.
    - Each sits on light beauty and its own grade.
  - **Fun:**
    - face warps (12, phone): Big eyes (unchanged), Bobble head, Tiny face, Alien, Chipmunk, Big nose, Big mouth, Long face, Wide face, Swirl, Jelly, Symmetry;
    - picture effects (12, both apps): Fisheye, Kaleido, Mirror, Funhouse, Glitch, VHS, Pop art, Comic (halftone), Sketch (hatching), Pixel, Neon, Thermal.
  - **Filters (12, both apps):** Golden, Cine, Film, Matte, Dream, Vivid, Arctic, Sunset, Pastel, Mono, Noir, Vintage. They use curves, split toning, halation, grain and vignettes.
  - Uniforms are unchanged, so the catalog runs on the installed build. Only roll needs the new one.
- **Roll** (`modules/pingdost-calls` `RollEstimator.kt`, ADR 0038's tracker):
  - After `FaceDetector` finds the eye midpoint, the worker turns two thin probes along a candidate eye line (±0.6 rad in 0.05 steps, with small offsets across the line).
  - It keeps the angle where both eyes are darkest, refined between steps. A slight preference for level breaks ties.
  - Weak contrast gives no angle: the last one is kept and eases back to level.
  - The result is smoothed into `uFace.w`.
- **Pickers:**
  - Phone (`screens/calls/effect-picker.tsx`): a `Segmented` group switch over a sideways row of round icon buttons, "None" first.
  - Web (`features/calls/effects-panel.tsx`): the same groups over a grid. Lenses are hidden where there is no tracker.
- **Self view:** drag it anywhere; it settles in the nearest corner (in the flick's direction on the phone). A tap still swaps big and small.
  - Phone (`screens/calls/self-view.tsx`): Gesture Handler pan plus Reanimated springs, the `CallMiniWindow` pattern. It stays between the minimize button and the controls, follows them when they show or hide, and respects the Motion setting.
  - Web (`SelfView` in `call-overlay.tsx`): pointer drag, then a FLIP slide (`pd-settle`, which follows Calm and Off). The arrow keys move it too.
- **Dropped:** Clown, Party hat and Mustache (replaced by better lenses), and a Cyclops warp that looked messy in testing.

## Consequences
- The catalog and the pickers are JS only. Roll needs a new Android build (calls module).
- The web still has no lenses or face warps. A face tracker there (TF.js + a face mesh, self-hosted, no telemetry) would be the next step. It would also give the phone mouth-open triggers (a tongue on the puppy) if run through TFLite. That is a separate decision: dependency size, licenses, telemetry check.
- Shader cost went up: beauty is about 15 taps; Glow, Hearts and similar add 12 more. Watch frame rate on low-end phones.

## Evidence
- `pnpm --filter @pingdost/call-engine test`: catalog rules (groups filled, labels ≤ 12 characters, sampling only through `sample(`, `tracksFace` ⇔ face helpers, lenses need the tracker, no ES 3 constructs).
- Chrome: the dev page's `checkEffectShaders()` returned `[]` for all 54 shaders, and `webEffects()` offers 30 (beauty 6, fun 12, filters 12).
- Every effect was rendered on a public-domain portrait (NASA) with a hand-set face anchor, and tuned from the results: puppy ears, aviator lenses, glitter, hearts, horns, the alien tint and Symmetry's blend were redone. Cyclops was dropped.
- `.\gradlew.bat :pingdost-calls:testDebugUnitTest`: `RollEstimatorTest` covers rolls from −0.45 to 0.5 rad within 0.05, a midpoint a few pixels off, and no eyes giving no angle. `:pingdost-calls:compileDebugKotlin` passes.
- Web, mobile and call-engine: typecheck, lint and tests pass; prettier clean. The web effects panel was rendered on the dev page (Beauty and Fun groups).
- Live call, web ↔ vivo (installed dev build, JS from Metro; PROGRESS 2026-11-20 has the details):
  - pickers, effects and self-view dragging work on both apps;
  - Puppy and Bunny tracked a real face in dim light;
  - fur edges and the puppy's nose were tuned from that picture.
- Roll is not tested on a device yet: it needs a new EAS build.
