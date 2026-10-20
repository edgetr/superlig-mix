# Süper Lig Mix — Draft Duel ⚽

Two managers, one player pool. Take turns drafting a starting XI from the **2026/27 Trendyol Süper Lig and the big clubs of Europe's top five leagues** (635 players: GS, FB, BJK, TS · Man City, Arsenal, Liverpool, Chelsea, Man United, Tottenham · Real Madrid, Barcelona, Atlético · Inter, Milan, Juventus, Napoli · Bayern, Dortmund, Leverkusen · PSG, Marseille, Monaco) — whoever you pick is gone for your rival. When both XIs are ready, **GPT-6.1 Sol** (high reasoning) plays the match out minute by minute on a neutral ground, and you watch it together as an animated, pausable, downloadable highlight video.

**Play:** https://superlig-mix.vercel.app

## How a game works

1. **Create a game** — you're the host and get a 5-letter code / invite link.
2. **Your rival joins** with the code, from anywhere (different network, different city — it's all synced through the server).
3. **Draft** — host picks first, then you alternate (host → rival → host …) until both have 11. No position rules: pick whoever you want, in any order. A player you pick is blacked out for your rival. Optional pick timer with auto-pick.
4. **Ready → Simulate** — the rival presses **Ready**, the host presses **Simulate**. Both line-ups appear side by side; the host presses **Continue**.
5. **Watch** — GPT-6.1 Sol streams the match in as it writes it. Either player can pause / resume / seek / change speed for both. At full time you get stats, player ratings and an analysis of each team: strengths, weaknesses and which real Premier League / LaLiga / Serie A / Bundesliga / Ligue 1 club it plays like. **Download** the whole thing as a video (MP4, or WebM where H.264 encoding isn't available).

## The match engine

GPT-6.1 Sol writes a rules-aware match script: team tactics (line height, press, width, tempo, build-up), and for every key moment who did what and **where** (pitch coordinates), how (foot, header, technique, shot placement, assist type, build-up), keeper actions and xG. The engine (`web/src/sim/`) then plays each moment out as real football in a 30 Hz world simulation; a director (`director.js`) only gives the protagonists objectives (“work it to the right winger, he crosses, Osimhen attacks the near post, the keeper saves”) — everything else is decided by the players themselves:

- **Ball physics** (`ball.js`): gravity, air drag, Magnus force (curling free kicks, dipping shots), bounces, posts, crossbar and net, and a real contact model with the grass — a ball struck without topspin **skids** until friction has spun it up to rolling, then rolls with speed-dependent resistance. A touch bursts away from the foot and settles; a pass zips and then rolls on. Every pass, cross and shot is a real strike: the kicker's foot gives the ball the velocity and spin that make the *simulated* ball arrive where the play needs it.
- **Bodies** (`world.js`): acceleration that fades towards each player's top speed (role and age), harder braking, a turning circle that widens with speed, and body orientation tied to the run — you can only shuffle sideways or backpedal slowly, so a player who wants to play it behind him slows down, plants and turns first. Decisions reach the legs with a short lag (nobody changes direction on the frame he decides to), effort scales with how close the play is (jogging into shape, sprinting to press or track a runner), and jumps, dives and slides are **ballistic** — once a player leaves the ground nobody steers. Team-mates ease past each other; opponents in a duel collide shoulder to shoulder and share momentum.
- **The ball is never glued to anyone** (`carry.js`): a carrier only acts on it through **touches**, with the foot that is swinging through at that point of his stride, and only in directions that foot can play relative to his body (laces straight on, inside and outside of the foot across and away, the sole to stop or drag it back). At pace he can only bend his run; a sharp change needs a checking touch to slow down first, a cut, or a drag-back and a turn of the body. How far each touch goes is a decision — knocked on and run onto in space, kept close with someone near — and every candidate touch is raced against every opponent (`race.js`: reaction, turning, braking and acceleration), so a heavy touch can be nicked. Passes and shots are struck in stride after setting the ball, never into a man standing on the ball's path; receivers attack the ball's actual path and open their body to where they're going next; first-time finishes and headers are timed to the ball's arrival (a header from a high ball is a jump that peaks as it arrives).
- **Contests**: every loose ball is a race — the dribbler's knock-on, a pass, a rebound — and whoever gets there first plays it. Defenders close down fast, brake, then jockey goal-side on the inside shoulder, and go in (a poke, a slide) when the ball is away from the dribbler's feet; a dribbler who sees the challenge coming knocks it past the man, who then has to recover. Interceptions need reaction time — nobody blocks a pass struck from a yard away.
- **Off the ball, everyone plays**: the team in possession offers passing angles in open lanes, keeps width and spacing, stays onside, makes runs on the shoulder of the last defender and calls for it; the team without it presses, covers, tracks runners goal-side at their pace, screens passing lanes, holds a real offside line and can spring an offside trap; everybody checks over his shoulder every few seconds and the man on the ball looks up between touches. Keepers stay on their toes in a ready stance as the ball approaches, set as the shot is struck, take a power step and launch along the line (rising with the ball's height), land on their side and get back up. The referee and assistants follow play. **Passes only go into open lanes** — a team never gives the ball to an opponent standing in the way.
- **Laws of the Game:** kick-off (conceding team restarts), sides switch at half-time, free kicks from where the ball stopped after the foul with a 9.15 m wall that jumps, penalties from the spot with everyone outside the box and arc, corners from the right flag, goal kicks, throw-ins, assistant referees flag real offsides, two yellows make a red (and the team plays on with ten).
- **3D players with motion capture** (`web/src/match/three/`): every player is a skinned human body (MakeHuman, CC0) at his real height, wearing his team's kit (name and number on the back, keeper gloves and long sleeves) with **his real face** fitted from his Transfermarkt photo (see *Faces* below). Movement is real motion capture from the CMU database, retargeted to that skeleton: walk/jog/run/sprint gait cycles blended by speed and phase-locked to the distance actually covered (no foot sliding), backpedalling, leaning into turns and with acceleration, heads tracking the ball. Kicks are real soccer-kick captures (driven shots, side-foot passes, long balls, mirrored for left-footers) timed so the boot meets the ball on the frame the engine releases it; headers are real jumps peaking at contact; tripped players fall onto their chest and get up with a captured push-up. Keeper set/dive/landing, slide tackles, knee slides, celebrations, the referee's whistle/cards/pointing and the assistant's flag are posed on the same skeleton with IK.
- **Faces** (`face.js`, `faceWorker.js`, `faceFit.js`): when the line-ups are on screen, a Web Worker runs [MediaPipe](https://ai.google.dev/edge/mediapipe) Face Landmarker (478 landmarks + irises), the hair segmenter and the person segmenter on each portrait. The same 478 landmarks were found once on the MakeHuman head (`models/face_fit.json`, made with `face-lab.html?fit`), so the photo maps onto the head through a scaled-orthographic camera plus a 3D thin-plate spline: eyes, nose, mouth and jaw land on the mesh's own features, and part of the difference becomes the player's **head shape** (per-player vertex offsets, face width, jaw, nose). Each photo is then baked once on the GPU into the head's UV atlas (MakeHuman's unwrap) plus a high-resolution front view of the face: the photo's own lighting is taken out (a fitted light model, a skin-only shading map, shine compression) so the stadium lights shade it again, the background is masked out, the face feathers into the body's skin tone (measured from the same de-lit face, so neck, arms and face match), the real hairline and hair come from the photo where it sees the scalp, and the rest of the head gets procedural hair in the player's top and side colours with a volume measured from the photo (bald and shaved heads stay bare). Beards continue under the jaw; eyeballs are shaded with the iris and sclera colour from the photo. If a face can't be found the photo is placed with the old framing heuristic; without a photo the head stays plain. All of it happens once per photo (~0.3–0.8 s per player in the worker, ~1 ms of GPU baking) — nothing runs per frame beyond two texture reads in the head shader.
- **Stadium:** WebGL (three.js) floodlit pitch with anti-aliased shader-drawn markings and mowing stripes, stands with crowds, roofs and floodlights, LED boards with both team names, goals whose nets ripple where the ball hits, a stitched match ball that rolls with its travel, real-time shadows — rendered at the display's native resolution (Retina) and composited under the TV graphics.
- **Broadcast:** highlights edited like a TV package (`web/src/match/renderer.js`, "the edit"). Every moment is one story beat cut from the simulated clip's own marks: it joins the move at the pass that starts it (or the referee's whistle for a set piece) and leaves right after the payoff and a short reaction — the celebration close-up, the keeper holding on, the card being shown — never through restarts, goal kicks or players walking back. Low-value incidents (cleared corners, ordinary fouls, filler possession, kick-offs after goals) aren't shown. Big moments get a speed-ramped replay of the decisive 2–4 s (near real speed in, ~0.4× around the strike, save or contact, then back up), goals a second angle over the shooter's shoulder, offsides a camera square on the line; goals and offside calls end on a freeze-frame analysis image (pass arrows, shot line, offside line, the protagonists lifted out of the dimmed picture, mini tactical map). Cuts are motivated: a team stinger with the minute between moments, a REPLAY wipe into replays, a flash into the analysis image, a dip into the full-screen graphics (line-ups, half-time and full-time stats, player of the match, ratings, team analysis). Within a clip the main camera tracks and tilts with play, pushes in on the shot and cuts to a close-up for the celebration or the booking, held to the end of the clip. Length follows the content — the mock match runs about 3:50 instead of 7:35, goals getting the most time. The engine runs in a Web Worker and every scene is rehearsed off-screen during the line-ups, so playback holds the display's refresh rate (144 Hz at 2560×1440 in testing). Video downloads are rendered at 1920×1080.

## Why the host runs a small helper

The match is simulated with **GPT-6.1 Sol on the host's ChatGPT plan** using OpenAI's [Sign in with ChatGPT for open-source apps](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt). That flow is designed for apps running on your own computer: the OAuth redirect goes to `127.0.0.1`, and the ChatGPT tokens must stay on the machine (never in a browser or a server). So only the **host** runs:

```bash
npx github:edgetr/superlig-mix
```

This starts the open-source [host helper](companion/host.mjs) at `http://127.0.0.1:1457`, where the host clicks **Sign in with ChatGPT**. In the game, the host clicks **Connect ChatGPT → Link this game**. The helper then watches that game and, when the host presses Simulate, calls `gpt-6.1-sol` (`reasoning.effort: "high"`, `store: false`, streaming) and streams the result into the room. Tokens are stored in `~/.superlig-mix/credentials.json` (mode `0600`). Matches count toward the host's ChatGPT plan usage — see [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).

The joining player doesn't need ChatGPT, Node or anything else — just the link.

## Architecture

| Part | What it does |
| --- | --- |
| `web/` | Vite + vanilla JS front-end (Motion for UI animation). Draft board, lobby, line-ups, match player. |
| `web/src/match/` | Deterministic renderer for the match "video" (scenes, TV graphics) + offline video export (WebCodecs via [mediabunny](https://github.com/Vanilagy/mediabunny)). |
| `web/src/match/three/` | WebGL stadium and players ([three.js](https://threejs.org)): body/motion loader, kit + face shader, motion controller (mocap blending, actions, IK). |
| `tools/mocap/` | Offline build of the player body (MakeHuman) and motion library (CMU mocap) — see its README. |
| `convex/` | [Convex](https://convex.dev) backend: rooms, turn order and pick validation (server-side), pick timer, ready/simulate, shared playback clock, match event stream. |
| `companion/host.mjs` | Host helper: Sign in with ChatGPT (PKCE + loopback), GPT-6.1 Sol calls, JSON Lines parsing, streaming into Convex. |
| `shared/` | Player data (from transfermarkt.com) and formation/position rules used everywhere. |

## Development

```bash
npm install
npx convex dev          # creates a dev deployment and writes VITE_CONVEX_URL to .env.local
npm run dev             # http://127.0.0.1:5180
npm run host            # host helper (GAME_URL=http://127.0.0.1:5180 to point its links at your dev site)
```

Deploy: `npx convex deploy`, then build the web app with `VITE_CONVEX_URL` set to the production Convex URL (`npm run build` → `dist/`), e.g. on Vercel.

## Credits

Player names, positions, market values and photos: [transfermarkt.com](https://www.transfermarkt.com) (photos are linked, not redistributed).

3D body: [MakeHuman](http://www.makehumancommunity.org) HM08 base mesh, targets and `cmu_mb` rig from [MPFB2](https://github.com/makehumancommunity/mpfb2) — CC0 1.0.
Face analysis: [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-vision`) with the Face Landmarker, hair segmenter and selfie segmenter models (hosted in `web/public/mediapipe/`) — Apache License 2.0, © Google LLC.
Motion capture: *The data used in this project was obtained from [mocap.cs.cmu.edu](http://mocap.cs.cmu.edu). The database was created with funding from NSF EIA-0196217.*
Rendering: [three.js](https://threejs.org) (MIT). This is a fan project, not affiliated with the Süper Lig, its clubs, Transfermarkt or OpenAI. The simulations are AI fiction, just for fun.

MIT licensed.
