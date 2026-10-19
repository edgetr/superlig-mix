# Süper Lig Mix — Draft Duel ⚽

Two managers, one player pool. Take turns drafting a starting XI from the **2026/27 Trendyol Süper Lig** — whoever you pick is gone for your rival. When both XIs are ready, **GPT-6 Luna** (high reasoning) plays the match out minute by minute on a neutral ground, and you watch it together as an animated, pausable, downloadable highlight video.

**Play:** https://superlig-mix.vercel.app

## How a game works

1. **Create a game** — you're the host and get a 5-letter code / invite link.
2. **Your rival joins** with the code, from anywhere (different network, different city — it's all synced through the server).
3. **Draft** — host picks first, then you alternate (host → rival → host …) until both have 11. No position rules: pick whoever you want, in any order. A player you pick is blacked out for your rival. Optional pick timer with auto-pick.
4. **Ready → Simulate** — the rival presses **Ready**, the host presses **Simulate**. Both line-ups appear side by side; the host presses **Continue**.
5. **Watch** — GPT-6 Luna streams the match in as it writes it. Either player can pause / resume / seek / change speed for both. At full time you get stats, player ratings and an analysis of each team: strengths, weaknesses and which real Premier League / LaLiga / Serie A / Bundesliga / Ligue 1 club it plays like. **Download** the whole thing as a video (MP4, or WebM where H.264 encoding isn't available).

## Why the host runs a small helper

The match is simulated with **GPT-6 Luna on the host's ChatGPT plan** using OpenAI's [Sign in with ChatGPT for open-source apps](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt). That flow is designed for apps running on your own computer: the OAuth redirect goes to `127.0.0.1`, and the ChatGPT tokens must stay on the machine (never in a browser or a server). So only the **host** runs:

```bash
npx github:edgetr/superlig-mix
```

This starts the open-source [host helper](companion/host.mjs) at `http://127.0.0.1:1457`, where the host clicks **Sign in with ChatGPT**. In the game, the host clicks **Connect ChatGPT → Link this game**. The helper then watches that game and, when the host presses Simulate, calls `gpt-6-luna` (`reasoning.effort: "high"`, `store: false`, streaming) and streams the result into the room. Tokens are stored in `~/.superlig-mix/credentials.json` (mode `0600`). Matches count toward the host's ChatGPT plan usage — see [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).

The joining player doesn't need ChatGPT, Node or anything else — just the link.

## Architecture

| Part | What it does |
| --- | --- |
| `web/` | Vite + vanilla JS front-end (Motion for UI animation). Draft board, lobby, line-ups, match player. |
| `web/src/match/` | Deterministic canvas renderer for the match "video" + offline video export (WebCodecs via [mediabunny](https://github.com/Vanilagy/mediabunny)). |
| `convex/` | [Convex](https://convex.dev) backend: rooms, turn order and pick validation (server-side), pick timer, ready/simulate, shared playback clock, match event stream. |
| `companion/host.mjs` | Host helper: Sign in with ChatGPT (PKCE + loopback), GPT-6 Luna calls, JSON Lines parsing, streaming into Convex. |
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
