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

GPT-6.1 Sol writes a rules-aware match script: team tactics (line height, press, width, tempo, build-up), and for every key moment who did what and **where** (pitch coordinates), how (foot, header, technique, shot placement, assist type, build-up), keeper actions and xG. A deterministic football engine (`web/src/sim/`) then plays each moment out:

- **Physics:** human top speeds by role and age, acceleration that fades near top speed, braking, turning circles that widen with speed, body orientation separate from running direction (players watch the ball, back-pedal, side-shuffle), gait cycles that scale with speed.
- **Football intelligence:** formation-based team shape driven by ball position, possession and style; a real offside line held by the back four; attackers time their runs to stay onside; pressers close down; goalkeepers guard the line between ball and goal and never leave the box; passes are played into a teammate's run, and the passer waits for the run.
- **Laws of the Game:** kick-off (conceding team restarts), sides switch at half-time, free kicks from the foul spot with a 9.15 m wall, penalties from the spot with everyone outside the box and arc, corners from the right flag, goal kicks, throw-ins, assistant referees flag offsides, two yellows make a red (and the team plays on with ten).
- **3D player rig:** hips, IK knees and elbows, boots, shoulders, head (skin and hair sampled from each player's photo), shirt numbers — kicks with the real preferred foot, headers, slide tackles, lunges, falls, keeper dives, knee slides, the referee's cards and the assistant's flag — all projected through broadcast, behind-the-goal and close-up cameras.
- **Broadcast:** camera director (push-in on shots, celebration and booking close-ups), slow-motion replays from another angle, freeze-frame analysis images (pass arrows, shot line, offside line, spotlights, mini tactical map), half-time and full-time stats, player of the match, ratings and analysis. The engine runs in a Web Worker and every scene is rehearsed off-screen during the line-ups, so playback holds the display's refresh rate.

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
| `web/src/match/` | Deterministic canvas renderer for the match "video" + offline video export (WebCodecs via [mediabunny](https://github.com/Vanilagy/mediabunny)). |
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

Player names, positions, market values and photos: [transfermarkt.com](https://www.transfermarkt.com) (photos are linked, not redistributed). This is a fan project, not affiliated with the Süper Lig, its clubs, Transfermarkt or OpenAI. The simulations are AI fiction, just for fun.

MIT licensed.
