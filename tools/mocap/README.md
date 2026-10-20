# Player body and motion library

The 3D players are built offline from two free datasets and committed as small binaries in
`web/public/models/` (`body.*`, `anims.*`). Rebuild them with:

```bash
node tools/mocap/build_body.mjs     # MakeHuman body → body.json / body.bin
node tools/mocap/build_anims.mjs    # CMU mocap → anims.json / anims.bin
```

Downloads are cached in `tools/mocap/.cache/` (git-ignored).

## Body — MakeHuman (CC0 1.0)

`build_body.mjs` downloads the HM08 base mesh, macro targets and the CMU-compatible `cmu_mb`
skeleton with its skin weights from [MPFB2](https://github.com/makehumancommunity/mpfb2)
(assets released under CC0 1.0). It applies the young/male/athletic macro targets, keeps the body
and eyes, computes the joint positions, the top-4 skin weights and per-vertex kit regions
(head, torso, arms, legs, feet + continuous limb coordinates) that the kit shader uses to dress
each player.

## Motion — CMU Graphics Lab Motion Capture Database

`build_anims.mjs` downloads the takes listed in `spec.mjs` from
[mocap.cs.cmu.edu](http://mocap.cs.cmu.edu), solves the ASF/AMC skeleton per frame, and retargets
it onto the MakeHuman skeleton by rotation transfer (each bone's global rotation is re-based from
the CMU rest pose to the MakeHuman rest pose). Then:

- **gait cycles** (walk, jog, run, sprint, backpedal): foot strikes are detected, one clean cycle
  is cut from left strike to left strike, loop-closed, faced forward, travel removed, resampled to
  32 phases, and its speed/stride measured — the engine's gait phase uses the same stride table;
- **actions** (kicks, jump, fall, get-up, idle): trimmed, grounded, faced at a reference frame
  (e.g. the frame the boot meets the ball, found from peak toe speed), travel low-pass removed.

Quaternions are stored as Int16, root positions in millimetres.

The CMU data is free for use in research and products (not for resale as a motion library).
*The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with
funding from NSF EIA-0196217.*

## Face landmarks on the head

`build_body.mjs` also writes the head texture atlas (`headUV`: MakeHuman's own UV islands for the
head and ears, repacked into [0,1]², seam vertices split) and the eyeball region used by the face
pipeline (`web/src/match/three/face.js`). `web/public/models/face_fit.json` holds the 478 MediaPipe
Face Mesh landmarks located on this head: open `face-lab.html?fit` with the dev server, which renders
the bare head from the front, runs the Face Landmarker on it (averaged over a few skin tones and
lights), ray-casts every landmark onto the mesh and leaves `{ points, normals }` in `window.__fit`.
Re-run it only if the head geometry changes.
