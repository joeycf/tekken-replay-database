# tekken-replay-database

The **Tekken 8** game app for the [Replay Database platform](https://replaydatabase.com) —
a thin consumer of the [`replay-engine`](https://github.com/joeycf/replay-engine) Nuxt
layer (pinned tag), plus everything genuinely Tekken's own: the bespoke data pipeline,
the roster art, the `GameConfig`, and the carbon-steel/crimson theme.

Built as **Phase 4** of the platform plan (engine `PLAN.md` §4/§10): the second game, and
the proof that the engine is game-agnostic — Tekken is 1v1 with a rank ladder and no team
composition, so it exercises exactly the knobs 2XKO doesn't:

| knob | 2XKO | Tekken |
| --- | --- | --- |
| `charactersPerSide` | 2 | **1** — single badge per side; duo/synergy panels self-hide |
| `filters.coOccurrence` | true | **false** — the "same side" filter never renders |
| `filters.rank` | false | **true** — the 30-rank ladder facet (`data/ranks.json`) |
| `terms` / `characterRouteSegment` / `Side.players` | overridden | **engine defaults, deliberately** |

## Layout

- `nuxt.config.ts` — extends the pinned engine tag (`ENGINE_PATH=../replay-engine` in
  `.env` for local co-development); prerender seeds from the registries; the
  `build:before` copy of `data/replays.json → public/data/`.
- `app/app.config.ts` — the Tekken `GameConfig` (accents transcribed from
  `design/handoff/tokens.css`, ranks imported from `data/ranks.json`).
- `app/assets/theme.css` — the full re-skin: every semantic token shadowed via a plain
  `:root` block (**not `@theme`** — see the comment in the file: an app-side `@theme` is
  silently dropped from the production bundle) + self-hosted Rajdhani / Archivo /
  JetBrains Mono via `@fontsource`.
- `app/plugins/registries.ts` — `provideRegistries({ characters, players, stats })`
  (bundled registries → real prerendered HTML for character/player/stats pages).
- `scripts/` — the bespoke pipeline (below) + `icons.ts` / `og.ts` brand asset
  generators + `e2e.ts` (the Phase-4 genericity audit as an executable suite).
- `data/` — committed pipeline artifacts (`videos.json` substrate, generic
  `replays.json` / `stats.json` / `characters.json` / `players.json`, `ranks.json`,
  `seasonBoundaries.json`, `overrides.json`, `report.md`).
- `design/handoff/tokens.css` — the Tekken skin's design source of truth (palette,
  fonts, all 42 `--char-*` accents).

## Data pipeline (bespoke; emits the engine's generic schema)

```bash
npm run data:fetch       # YouTube Data API → raw/<channel>.json   (YT_API_KEY, local-only)
npm run data:parse       # raw → data/videos.json + players.json + report.md, then emits
npm run data:build       # fetch + parse
npm run data:emit        # re-derive replays.json/stats.json from committed data (no network)
npm run data:characters  # roster scrape (Bandai Namco official site) → art + characters.json
```

- **Sources:** three tracked replay channels (`scripts/channels.ts`) with ≥98%
  structurally parseable `PLAYER (Character) vs PLAYER (Character)` titles.
- **Ranks** come from the video *descriptions* ("Keisuke (God of Destruction 6 Kazuya)
  Versus …"), normalized onto the 30-rank ladder (GoD sub-tiers → God of Destruction);
  ~45% of sides carry one. Title qualifiers ("#6 Ranked") are leaderboard positions, not
  ladder ranks, and are ignored.
- **Seasons** (`Replay.patch` = S1/S2/S3) resolve by authoritative patch dates
  (`scripts/parse.ts` SEASONS; S3 = 2026-03-17), with channel labels honored only near a
  boundary — the report counts label conflicts.
- **Roster** is discovered live from the official Tekken 8 site (42 characters incl. all
  DLC), portraits/splashes optimized to webp; re-run `data:characters` when new DLC
  drops (a missing `--char-*` accent in the design tokens fails loudly).
- `data/overrides.json` — per-video `{ "<id>": { "exclude": true } }` corrections,
  applied by parse and the standalone emit alike.
- `thumb` is deliberately omitted from `replays.json` (the engine derives it from the
  YouTube id) — ~1 MB off the whale file.

## Build & verify

```bash
npm run generate     # SSG → .vercel/output/static (~2,750 pages + sitemap/robots/manifest/404)
npm run typecheck    # nuxt typecheck (vue-tsc) + pipeline tsc
npm run lint         # @nuxt/eslint flat config (+ prettier last)
npm run test:e2e     # the Phase-4 audit: 51 browser checks against the generated output
```

## Deploy

Its own Vercel project: build command `npm run generate`, output `.vercel/output`
(vercel-static preset via the engine), env `NUXT_PUBLIC_SITE_URL` set to the project's
canonical origin. Vercel never runs the pipeline — the site builds from committed JSON;
`ENGINE_PATH` stays unset there so the pinned `github:` tag is used.
`.github/workflows/data-refresh.yml` refreshes data daily (repo secret `YT_API_KEY`)
and pushes only when something real changed, which triggers the Vercel rebuild.

---

Tekken 8 Replay Database is an unofficial fan project, not endorsed by or affiliated
with Bandai Namco Entertainment.
