# Tekken 8 Replay Database

A competitive replay database for **Tekken 8** — 14,000+ high-level and ranked
replays, filterable by character, matchup, player, rank, season, and channel,
with a stats dashboard (character usage, top matchups, meta over time) and
per-character / per-player pages.

The app is a **thin layer over [replay-engine](https://github.com/joeycf/replay-engine)**
(pinned by tag in `nuxt.config.ts`): the engine owns the generic replay-database
UI and data contract, and this repo supplies the Tekken data pipeline, theme, and
`GameConfig`. It ships under `/tekken/` behind the replaydatabase.com shell.

Tekken was built as the platform's **second** game — the proof that the engine is
genuinely game-agnostic. It is 1v1 with a rank ladder and no team composition, so
it exercises exactly the knobs 2XKO doesn't:

| knob                                               | 2XKO       | Tekken                                                                  |
| -------------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `charactersPerSide`                                | 2          | **1** — single badge per side; duo/synergy panels self-hide             |
| `filters.coOccurrence`                             | true       | **false** — the "same side" filter never renders                        |
| `filters.rank`                                     | false      | **true** — the 30-rank ladder facet (`data/ranks.json`)                 |
| `terms` / `characterRouteSegment` / `Side.players` | overridden | **engine defaults, deliberately** — Tekken really does say "characters" |

> Part of the **Replay Database** platform — [replaydatabase.com](https://replaydatabase.com) ·
> [engine](https://github.com/joeycf/replay-engine) ·
> [shell](https://github.com/joeycf/replay-database-shell) ·
> [2XKO](https://github.com/joeycf/2xko-replay-database)

## Architecture

```
YouTube Data API v3
      │  scripts/fetch.ts        (raw dumps → raw/*.json, gitignored)
      ▼
scripts/parse.ts                 (title parser + description ranks + aggregates)
      │   merge order: title parse → rank/season resolution → overrides
      ▼
data/videos.json                 (RICH records — the pipeline substrate)
      │  scripts/emit.ts         (runs at the end of every parse)
      ▼
data/replays.json + stats.json + summary.json   (GENERIC engine-contract files)
      │
      └─ committed ──►  Nuxt 4 static site (nuxt generate, vercel-static)
                          extends replay-engine layer
                                  │
                                  ├─ registries (characters/players/stats)
                                  │    → provided via plugin, prerendered into HTML
                                  ├─ replays.json (4.5 MB) → copied to
                                  │    public/data/ at build, fetched
                                  │    client-side on Browse and entity pages
                                  │    only (never bundled)
                                  └─ summary.json → copied to public/data/ at
                                       build; the apex selector's card counts
                                       (never read by this app)
```

Two schemas, deliberately: `videos.json` (6.4 MB, rich — parse provenance, miss
reasons, raw title fields) never reaches the browser; `emit.ts` maps it onto the
engine's generic `Replay[]` contract.

- **2,736 routes prerendered**: Browse shell, Stats, characters and players
  indexes, 42 character pages, all 2,689 player pages, plus `404.html`.
- The engine's `modules/static-artifacts` emits **`sitemap.xml`**, **`robots.txt`**,
  the web manifest and `404.html` from the _real_ prerendered route list. Per-page
  **JSON-LD** is prerendered into the HTML.
- The site builds **purely from committed JSON** — no API keys at deploy time.
- `thumb` is deliberately omitted from `replays.json` (the engine derives it from
  the YouTube id) — roughly a megabyte off the whale file.

## Setup

```sh
npm install
cp .env.example .env      # add your YouTube Data API v3 key (pipeline only)
npm run dev
```

`.env` is only needed to run the data pipeline locally. The web app never
reads it.

Two other env vars matter locally, neither of them secret:

- `ENGINE_PATH` — point at a local `replay-engine` checkout (e.g. `../replay-engine`)
  to co-develop app and engine. Unset, the pinned git tag is used; **Vercel leaves
  it unset**.
- `NUXT_APP_BASE_URL` — the site ships under `/tekken/`; set `/` for a root-based
  local preview. The committed default is production truth, so don't "simplify"
  the env expression in `nuxt.config.ts` — a literal value there shadows the
  engine's own read and 404s every prerendered route.

## Scripts

| script                                           | what it does                                                                                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `generate` / `preview` | Nuxt app (generate = full static build)                                                                                                                                                               |
| `npm run data:fetch`                             | Pull every upload from all four YouTube channels → `raw/` (needs `YT_API_KEY`)                                                                                                                        |
| `npm run data:parse`                             | Parse titles/descriptions → `data/videos.json`, `players.json`, `report.md`; calls `data:emit` at the end                                                                                             |
| `npm run data:theater`                           | Pull the Replay Theater tournament index → `raw/replayTheater.json` + the cross-check witness, advancing `data/theater-cursor.json`. Add `-- --full` for a whole-catalogue sweep (needs `YT_API_KEY`) |
| `npm run data:emit`                              | Map the rich `videos.json` onto the engine contract → `data/replays.json`, `stats.json`, `summary.json`. Deterministic, no YouTube access — safe to re-run standalone                                 |
| `npm run data:build`                             | fetch + parse                                                                                                                                                                                         |
| `npm run data:characters`                        | Roster scrape (Bandai Namco official site) → portraits + splashes in `public/img/characters/`, `data/characters.json`                                                                                 |
| `npm run typecheck`                              | App (`nuxt typecheck`) **and** pipeline (`tsc -p tsconfig.pipeline.json`) — both must pass                                                                                                            |
| `npm run lint` / `lint:fix`                      | ESLint over the whole repo                                                                                                                                                                            |
| `npm run format` / `format:check`                | Prettier                                                                                                                                                                                              |
| `npm run test:e2e`                               | The genericity audit — browser checks against the generated output (run `npm run generate` first)                                                                                                     |
| `npx tsx scripts/og.ts`                          | Regenerate the default OG card (`public/og-default.png`)                                                                                                                                              |

## Vercel

Its own Vercel project. `vercel.json` commits the build command and framework
preset; the rest is dashboard config:

| setting               | value                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework preset      | **Nuxt** (`vercel.json` → `"framework": "nuxtjs"`)                                                                                                    |
| Build command         | `npm run generate` (committed in `vercel.json`)                                                                                                       |
| Output directory      | _(auto — Build Output API, `.vercel/output`)_                                                                                                         |
| Node.js version       | 24 (`engines.node: ">=24 <25"`; the data-refresh Action runs 24 too)                                                                                  |
| Environment variables | `NUXT_PUBLIC_SITE_URL` = the canonical origin (used for canonical/OG/sitemap absolute URLs). **No `YT_API_KEY`** — the pipeline never runs on Vercel. |

`ENGINE_PATH` stays unset on Vercel, so the pinned `github:` tag is used.
Deploys are triggered by pushes — including the daily data-refresh commit.

The deployment's own `tekken-replay-database.vercel.app` alias stays reachable
and is **never** host-redirected to the apex: the shell reaches this project
through an edge rewrite, so a host redirect here would loop.

`vercel.json` carries one **path** redirect, `/` → `/tekken`. The build nests
every route under `app.baseURL`, so this project's own root holds nothing but
`404.html` — which is what the Vercel dashboard's Visit link used to land on. Two
constraints keep it safe, and both are easy to "improve" into an outage:

- The destination stays **relative**. An absolute `https://replaydatabase.com/tekken`
  would fire on every **preview** deployment too, bouncing a reviewer off the
  preview they meant to inspect and onto production.
- It stays a **path** redirect, never a host one — see the paragraph above.

It cannot disturb the shell, which only ever requests `/tekken` and `/tekken/*`
at this child, never `/`.

## Analytics

Both are Vercel-native, inherited from the engine, inert outside production, and
inject nothing into the prerendered HTML (they attach client-side):

- **Web Analytics** — reports to **this project**, via
  `observability.insights: '/tekken-insights'` in `app/app.config.ts`.
- **Speed Insights** — reports to the **shell's** project at `sampleRate 0.5`.
  Not per-game on purpose: Speed Insights is single-project on Hobby.

The wiring lives in the engine (`app/plugins/vercel-observability.client.ts`);
this repo configures only the endpoint. That one line is **paired with a rewrite
in the shell's `vercel.json`** — `/tekken-insights/:path*` →
`https://tekken-replay-database.vercel.app/_vercel/insights/:path*`. Change one
without the other and every beacon 404s, silently.

That is not hypothetical: the Phase-5 subpath cutover killed analytics outright
for ~10 days. Vercel bakes a per-project obfuscated script path into each build,
and proxied onto the apex it 404s, so both SDKs reported **nothing** — dropped,
not misattributed. `npm run test:e2e` now gates the wiring, and the shell's
`verify:cutover` gates that it resolves through the apex.

## Daily data refresh

`.github/workflows/data-refresh.yml` runs daily at 06:47 UTC (and via
_Run workflow_) on Node 24, in three steps rather than one `data:build`:
`npm run data:fetch` (the four YouTube channels), then `npm run data:theater`
(the Replay Theater tournament index), then `npm run data:parse`. Both fetches
take `YT_API_KEY` from repo **Actions secrets** — `env:` is per step, so the key
is repeated.

**The theater pull is allowed to fail.** It carries `continue-on-error: true`
and runs last, so a bad morning upstream cannot cost the channel dumps already
fetched: the run goes yellow, `data:parse` finds no dump, and the committed
index records are CARRIED unchanged (`cronFetchedWithCarry` in
`scripts/channels.ts`). An empty dump is treated the same way, which here is the
ordinary case — the catalogue's tagged Tekken rows stop at 2025-03-16.

The commit stages
`data/{videos,replays,stats,players,summary,seasonBoundaries,player-redirects,patchGroups,review-queue,source-pins,theater-cursor,theater-disagreements}.json`

- `report.md` **only if changed** ("data: refresh YYYY-MM-DD — N replays"). The
  push triggers the Vercel deploy. Two files are suppressed when they are the only
  diff: `report.md`'s `_Generated <timestamp>_` line, and `theater-cursor.json`,
  which advances whenever the catalogue takes new entries whether or not any of
  ours changed. So a `report.md` diff in history always means real data changed,
  and a quiet day still produces no commit and no deploy. The 06:47 slot is offset
  from the 2XKO app's 06:17 so the two refreshes never contend. Character art is
  deliberately not part of the daily run.

## The parser: characters, ranks, and seasons

Tekken's titles are far more structured than 2XKO's, so there is no computer
vision here — everything comes out of the title and description text.

- **Sources:** four tracked channels (`scripts/channels.ts`) with
  `PLAYER (Character) vs PLAYER (Character)` titles, feeding four sources.
  Latest run: **14,322 matches parsed from 21,909 uploads** — per-channel
  coverage 99.2% (highLevel), 60.1% (telly), 99.2% (ranked), 7.5% (bneEsports).
  The misses are dominated by material that isn't a match at all: pre-launch
  footage, Shorts, and short-duration clips.
- **A source may aggregate several channels.** `tournament` is fed by the event
  organizers' channels — currently Bandai Namco Esports (TEKKEN World Tour),
  213 matches. Its low coverage is the parser working as intended: the channel
  is mostly multi-hour stream VODs and a Tekken _7_ back-catalogue, and only
  the per-match uploads carry the title contract. `ChannelConfig.id` is the
  intake key (`raw/<id>.json`, report row); `ChannelConfig.source` is the
  public `Replay.source`.
- **Org tags are stripped from handles** (`ORG_PREFIXES` in `scripts/parse.ts`):
  tournament uploads credit the sponsor ("VIT JeonDDing", "KDF Mulgold"), which
  would otherwise mint one player page per sponsor — and Mulgold has appeared
  under KDF, DNF and bare. The list is curated rather than inferred; the
  tempting heuristic scores `ARSLAN ASH → ASH` and `BUFFALO SOLDIER → SOLDIER`.
- **Character matching** (`scripts/roster.ts`) is longest-alias-first whole-word
  search, so "Armor King" beats "King" and "Devil Jin" beats "Jin". Aliases come
  from `data/characters.json`, which the roster scrape writes — parse vocabulary
  and the app's search vocabulary are the same data.
- **Ranks** come from the video _descriptions_ ("Keisuke (God of Destruction 6
  Kazuya) Versus …"), normalized onto the 30-rank ladder; **12,640 of 28,644
  sides (44.1%)** carry one. Tournament uploads state no ladder rank, so their
  sides ship rank-less (`rank` is optional per side). Season 2's God of Destruction sub-tiers (I–VII, ∞)
  sit above the named ladder as orb progression and all normalize back to "God of
  Destruction". Title qualifiers like "#6 Ranked" are leaderboard positions, not
  ladder ranks, and are ignored.
- **Seasons** (`Replay.patch` = S1/S2/S3) resolve by authoritative patch dates
  (`scripts/parse.ts` `SEASONS`; S3 = 2026-03-17), with channel labels honored
  only within a ±14-day boundary grace. Date wins otherwise, and `report.md`
  counts the conflicts.
- `data/overrides.json` — per-video `{ "<id>": { "exclude": true } }`
  corrections, applied by parse and the standalone emit alike. Currently empty;
  it exists so a correction never has to be made by editing `videos.json` in
  place, which the next refresh would erase.

## New-character / DLC runbook

1. Add the accent token `--char-<id>` to `design/handoff/tokens.css`, and the
   matching entry to `accents` in `app/app.config.ts`.
2. Run `npm run data:characters` — the roster is rediscovered live from the
   official site each run, so a new DLC character is picked up automatically:
   portrait + splash are downloaded and optimized to webp, and
   `data/characters.json` is rewritten. A roster id with no `--char-*` token
   **fails loudly** rather than shipping an unstyled character.
3. Re-run `npm run data:parse` and check `data/report.md`: a spike in
   `char-unresolved` misses means titles mention a character the registry
   doesn't know yet.
4. Commit + push (redeploys).

## Dev tooling (local-only)

**Start at [`/dev`](http://localhost:3000/tekken/dev)** — it lists every tool below with its
description, and there is a **Dev** entry in the site nav while the dev server is
running. That index is the engine's (`app/pages/dev/index.vue`); it builds itself
from what each page declares in `definePageMeta({ devTool })`, so a new tool
appears there the moment it exists.

One page does the hand-curation the parser can't.

Everything under `/dev` is **`nuxt dev` only**: the page and every `/api/dev/*`
route it uses guard on `import.meta.dev` and 404 otherwise,
`nitro.prerender.ignore` skips the whole `/dev` prefix, and nothing public links
to them (the nav entry is compiled out of production builds). They read and write
the committed JSON directly — there is no database.

| page                 | what it's for                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `/dev/source-review` | Adjudicate the character-completion review queue from sampled HUD frames → `data/overrides.json` |

## Tech stack & engineering notes

For engineers reading the source — the stack, and the decisions worth knowing.

### Stack

Shape only; the engine's [`STACK.md`](https://github.com/joeycf/replay-engine/blob/main/STACK.md)
is the single source of pinned versions.

| layer         | choice                                         | notes                                                                                                                                                |
| ------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | **Nuxt 4** (Vue 3, `<script setup>`)           | `ssr: true` for prerender fidelity, but the output is **100% static** — `nitro` `vercel-static` preset, `nuxt generate`                              |
| Base layer    | **replay-engine**, pinned by tag               | `extends:` a git layer (`install: true` is required, or its runtime deps don't resolve). `ENGINE_PATH` swaps in a local checkout for co-development  |
| Language      | **TypeScript** end to end                      | dual typecheck: `nuxt typecheck` (vue-tsc) for the app, `tsc -p tsconfig.pipeline.json` for the pipeline; shared types in `types/index.ts`           |
| Styling       | **Tailwind CSS v4**, via the engine layer      | no `tailwind.config.js` anywhere in the build — the Tekken skin is `app/assets/theme.css`, which loads after the engine CSS and shadows its defaults |
| Fonts         | **`@fontsource/*`**, imported in `theme.css`   | Rajdhani / Archivo / JetBrains Mono, Vite-processed and hashed — no runtime CDN, no `public/` `url()`s                                               |
| Images        | **sharp**                                      | roster portraits + splashes (webp), OG card                                                                                                          |
| Data pipeline | standalone **`tsx`** scripts                   | no build step; YouTube Data API v3 for metadata                                                                                                      |
| Tests         | **playwright-core** (bespoke harness)          | not `@playwright/test` — the suite is a plain script                                                                                                 |
| Analytics     | Vercel **Web Analytics** + **Speed Insights**  | inherited from the engine; client-only, inert outside production                                                                                     |
| Host          | **Vercel** Build Output API (`.vercel/output`) | daily GitHub Actions cron for the data refresh                                                                                                       |
| Node          | **24** (`engines.node: ">=24 <25"`)            | matched by the data-refresh Action                                                                                                                   |

### Things worth knowing

- **This repo is deliberately small.** `app/` holds exactly three files —
  `app.config.ts`, `assets/theme.css`, `plugins/registries.ts`. Every page,
  component, and composable comes from the engine. If something here starts
  looking like generic replay-database UI, it belongs upstream instead.
- **The engine defaults are load-bearing, not laziness.** Tekken leaves `terms`,
  `characterRouteSegment`, and `Side.players` unset because it genuinely says
  "characters", ships at `/characters/*`, and has one player per side. Exercising
  the defaults is what proves they work.
- **The theme must stay in `:root`.** `app/assets/theme.css` declares the Tekken
  palette as plain `:root` custom properties, never `@theme`. Under `@theme` the
  dev server still looks correct while the production build drops the tokens — a
  failure that only shows up after deploy. Removing the file entirely should drop
  the site to the neutral engine look; that's the override-contract proof.
- **The design tokens are the source of truth for accents.**
  `design/handoff/tokens.css` carries all 42 `--char-*` values;
  `app/app.config.ts` transcribes them and `scripts/characters.ts` reads the same
  file when enriching `data/characters.json`, so config and data can't drift.
- **Two-tier data loading.** The registries (characters/players/stats) are
  provided through `app/plugins/registries.ts` and prerendered into the HTML; the
  4.5 MB `replays.json` is copied to `public/data/` at build and fetched
  client-side only on the pages that need it — **never bundled**, so the JS
  payload stays flat as the catalog grows.
- **Stats are computed once.** `scripts/stats.ts` is shared by `parse.ts` and the
  standalone `emit.ts` so both derive identical numbers from the same records.
  1v1 usage counts **side appearances**, so a Kazuya mirror adds 2 — the same
  denominator the engine's usage bars, per-season timelines, and player tables
  all read.
- **Zero-secret static deploy.** The whole site builds from committed JSON with
  no API keys at deploy time; the YouTube key only ever lives in local `.env` and
  GitHub Actions secrets, never on Vercel.
- **Hero framing is config, not CSS.** Tekken's splashes are tall portrait renders
  with the head near the top, so `heroFocus: '70% 4%'` biases the character-page
  crop upward (the engine default `'70% 25%'` suits 2XKO's wide splashes). X stays
  at 70% to hold the subject clear of the name/stat overlay.
- **The stats page gives the timeline the whole row.** Tekken ships no
  `GameStatsPanels` override, so the engine's `beside-timeline` anchor is empty —
  `stats.metaTimelineFullWidth` reclaims the space rather than leaving a hole.

---

Tekken 8 Replay Database is an unofficial fan project, not endorsed by or affiliated
with Bandai Namco Entertainment.

> Feature requests and bug reports are welcome via Issues.
