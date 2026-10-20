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

- **Ball physics** (`ball.js`): gravity, air drag, Magnus force (curling free kicks, dipping shots), bounces with friction, rolling resistance on grass, posts, crossbar and net. Every pass, cross and shot is a real strike: the kicker's foot gives the ball the velocity and spin that make the *simulated* ball arrive where the play needs it.
- **Bodies** (`world.js`): acceleration that fades towards each player's top speed (role and age), harder braking, a turning circle that widens with speed, and body orientation tied to the run — you can only shuffle sideways or backpedal slowly, so a player who wants to play it behind him slows down, plants and turns first. Players never pass through each other; shoulder-to-shoulder duels are allowed.
- **On the ball**: dribbling with real touches (knocked ahead in space, close control with a defender in front), set-up touches and a wind-up before every pass and shot, receivers that move to meet the ball's actual path, first-time finishes and headers timed to the ball's arrival, tackles and blocks that have to physically reach the ball or the man.
- **Off the ball, everyone plays**: the team in possession offers passing angles in open lanes, keeps width and spacing, stays onside, makes runs on the shoulder of the last defender and calls for it; the team without it presses (jockeying, giving ground to a runner), covers, marks goal-side, screens passing lanes and holds a real offside line; keepers guard the angle, set as the shot is struck and dive along the line facing the shooter; the referee and assistants follow play. **Passes only go into open lanes** — a team never gives the ball to an opponent standing in the way.
- **Laws of the Game:** kick-off (conceding team restarts), sides switch at half-time, free kicks from where the ball stopped after the foul with a 9.15 m wall that jumps, penalties from the spot with everyone outside the box and arc, corners from the right flag, goal kicks, throw-ins, assistant referees flag real offsides, two yellows make a red (and the team plays on with ten).
- **3D players with motion capture** (`web/src/match/three/`): every player is a skinned human body (MakeHuman, CC0) at his real height, wearing his team's kit (name and number on the back, keeper gloves and long sleeves) with **his real face** projected from his Transfermarkt photo onto the head. Movement is real motion capture from the CMU database, retargeted to that skeleton: walk/jog/run/sprint gait cycles blended by speed and phase-locked to the distance actually covered (no foot sliding), backpedalling, leaning into turns and with acceleration, heads tracking the ball. Kicks are real soccer-kick captures (driven shots, side-foot passes, long balls, mirrored for left-footers) timed so the boot meets the ball on the frame the engine releases it; headers are real jumps peaking at contact; tripped players fall onto their chest and get up with a captured push-up. Keeper set/dive/landing, slide tackles, knee slides, celebrations, the referee's whistle/cards/pointing and the assistant's flag are posed on the same skeleton with IK.
- **Stadium:** WebGL (three.js) floodlit pitch with anti-aliased shader-drawn markings and mowing stripes, stands with crowds, roofs and floodlights, LED boards with both team names, goals whose nets ripple where the ball hits, a stitched match ball that rolls with its travel, real-time shadows — rendered at the display's native resolution (Retina) and composited under the TV graphics.
- **Broadcast:** highlights edited like a TV package — every moment joins the move a few seconds before the key action, and every cut is hidden by a transition (team-colour stingers with the minute, a REPLAY wipe, a flash into the analysis image); camera director (main camera tracking and tilting with play, push-in on shots, celebration and booking close-ups), slow-motion replays from behind the goal and the reverse angle, freeze-frame analysis images (pass arrows, shot line, offside line, the protagonists lifted out of the dimmed picture, mini tactical map), half-time and full-time stats, player of the match, ratings and analysis. The engine runs in a Web Worker and every scene is rehearsed off-screen during the line-ups, so playback holds the display's refresh rate (144 Hz at 2560×1440 in testing). Video downloads are rendered at 1920×1080.

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
Motion capture: *The data used in this project was obtained from [mocap.cs.cmu.edu](http://mocap.cs.cmu.edu). The database was created with funding from NSF EIA-0196217.*
Rendering: [three.js](https://threejs.org) (MIT). This is a fan project, not affiliated with the Süper Lig, its clubs, Transfermarkt or OpenAI. The simulations are AI fiction, just for fun.

MIT licensed.
