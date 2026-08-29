// Generic-schema emitter: maps the parse substrate onto the engine's data
// contract and writes the app-consumed files. Called by parse.ts at the end
// of every run, and runnable standalone (`npm run data:emit`) to re-derive
// the generic files from the COMMITTED videos.json + registries with no
// YouTube access — deterministic either way (stats math shared: scripts/stats.ts).
//
//   data/videos.json      (substrate, committed)  → INPUT
//   data/characters.json  (generic Character[])   → INPUT (scripts/characters.ts owns it)
//   data/players.json     (generic Player[])      → INPUT (parse.ts round-trips it)
//   data/replays.json     (generic Replay[])      → EMITTED (compact — the
//                                                   client-fetched whale file)
//   data/stats.json       (KnownStats, 1v1 keys)  → EMITTED
//   data/summary.json     (the shell selector's card) → EMITTED (Phase 6)
//   public/data/{replays,summary}.json            → EMITTED copies (gitignored;
//                                                   the build's build:before
//                                                   hook does the same on
//                                                   Vercel, which never runs
//                                                   the pipeline)
//
// `thumb` is deliberately NOT emitted: Replay.id is a YouTube id, and the
// engine derives i.ytimg.com/vi/<id>/hqdefault.jpg when thumb is absent —
// ~50 bytes × every replay saved off the whale file.

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS } from './channels';
import { loadPatchTable } from './patches';
import { RANK_SET } from './roster';
import { buildStats, sort1, sort2 } from './stats';
import type { CharacterRecord, MatchVideo, PlayerRecord, VideoOverride } from '../types/index';

// ── the emitted generic shapes (mirror @engine/types — the pipeline can't
//    resolve the Nuxt alias, so the contract is restated here) ───────────────
export interface GenericSide {
  player: string;
  /** ≥1 — one per game played, first-appearance order (see MatchSide). */
  characters: string[];
  rank?: string;
}
export interface GenericReplay {
  id: string;
  sides: [GenericSide, GenericSide];
  date: string;
  patch?: string;
  source: string;
  title: string;
  views?: number;
  durationSec?: number;
  /** The YouTube id, when `id` is not it (engine v0.10.0). A record is not
   *  required to be a whole video: an index intake publishes many per VOD. */
  videoId?: string;
  /** Where this record's footage starts inside `videoId`, in seconds. */
  startSeconds?: number;
}

/** The game's identity as it appears in data/summary.json — the shell selector
 *  keys its cards on it. Restated here for the same reason the generic shapes
 *  above are: the pipeline can't resolve the Nuxt `@engine`/app.config graph.
 *  app/app.config.ts is the authority (note id 'tekken8' ≠ slug 'tekken'); the
 *  shell's verify:cutover asserts these two values against its own GAMES table,
 *  so a drift fails at the apex. */
const GAME_ID = 'tekken8';
const GAME_NAME = 'Tekken 8';

/** Season number → the patch key the UI filters/timelines on. */
const patchKey = (season: number): string => `S${season}`;

/** bySeason keys in timeline order (numeric ascending: S1 → S2 → S3). */
const timeline = (keys: string[]): string[] => [...keys].sort((a, b) => Number(a) - Number(b));

const remapSeasons = (
  o: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> =>
  Object.fromEntries(timeline(Object.keys(o)).map((k) => [patchKey(Number(k)), sort1(o[k]!)]));

function toReplay(v: MatchVideo): GenericReplay {
  return {
    id: v.id,
    sides: v.sides.map((s) => ({
      player: s.player,
      characters: s.characters,
      ...(s.rank ? { rank: s.rank } : {}),
    })) as [GenericSide, GenericSide],
    date: v.publishedAt,
    // fine patch token when the boundary derivation produced one; the bare
    // era token means "season known, patch unknown" (label-grace/override) —
    // the engine's patchGroups facet gives both the right semantics (v0.6.0)
    patch: v.patchVersion ?? patchKey(v.season),
    source: v.channel,
    title: v.title,
    ...(v.viewCount !== undefined ? { views: v.viewCount } : {}),
    ...(v.durationSec > 0 ? { durationSec: v.durationSec } : {}),
    // GUARDED INDEPENDENTLY, and here that is not a nicety. startSeconds 0 is
    // falsy, and 32 of this catalogue's 62 VODs are single-entry at offset 0 —
    // 10% of the ingest. Under a single combined spread every one of them would
    // lose `videoId` too, and the engine resolves `videoId ?? id`, so each would
    // render a thumbnail and an embed for the literal string "abc@0": a 404 and
    // a dead player, on exactly the records least likely to be spot-checked.
    ...(v.videoId ? { videoId: v.videoId } : {}),
    ...(v.startSeconds ? { startSeconds: v.startSeconds } : {}),
  };
}

/** Overrides-driven exclusions (`{ "<id>": { "exclude": true } }`): drops
 *  records the site must not carry (e.g. a stray non-match upload). Shared by
 *  parse.ts (future runs regenerate videos.json without them) and the
 *  standalone emit (applies them to the committed substrate immediately). */
export function applyOverrides(
  records: MatchVideo[],
  overrides: Record<string, VideoOverride>,
): MatchVideo[] {
  const excluded = new Set(
    Object.entries(overrides)
      .filter(([, ov]) => ov.exclude === true)
      .map(([id]) => id),
  );
  const out: MatchVideo[] = [];
  for (const v of records) {
    if (excluded.has(v.id)) continue;
    const ov = overrides[v.id];
    out.push(
      ov
        ? {
            ...v,
            ...(ov.season ? { season: ov.season } : {}),
            ...(ov.sides ? { sides: ov.sides } : {}),
          }
        : v,
    );
  }
  if (excluded.size > 0) {
    console.log(
      `  overrides.json excludes ${records.length - out.length} record(s): ${[...excluded].filter((id) => records.some((v) => v.id === id)).join(', ')}`,
    );
  }
  return out;
}

export async function emitGeneric(opts: {
  records: MatchVideo[];
  characters: CharacterRecord[];
  players: PlayerRecord[];
  root: string;
}): Promise<void> {
  const { records, characters, players, root } = opts;
  const DATA = join(root, 'data');

  const stats = buildStats(records);
  const replays = records.map(toReplay);

  const genericStats = {
    totals: {
      replays: stats.totals.videos,
      characters: characters.length,
      players: players.length,
      byPatch: Object.fromEntries(
        timeline(Object.keys(stats.totals.bySeason)).map((k) => [
          patchKey(Number(k)),
          stats.totals.bySeason[k]!,
        ]),
      ),
    },
    characterUsage: sort1(stats.characterUsage),
    byPatchUsage: remapSeasons(stats.bySeasonUsage),
    playerCharacters: sort2(stats.playerCharacters),
  };

  // ── contract assertions (drift = hard fail, the Phase-3 discipline) ──────
  const rosterIds = new Set(characters.map((c) => c.id));
  const playerIds = new Set(players.map((p) => p.id));

  /**
   * THE REGISTRY'S OWN INVARIANTS, which no game on this platform asserted until
   * a `""` player id shipped in tokon-replay-database: the slug strips to
   * [a-z0-9], so a handle written entirely in another script reduced to nothing,
   * and every downstream gate passed because the empty id WAS in the registry.
   * Uniqueness has never been checked for players either — patchGroups ids are,
   * sitemap locs are — and identity resolution is exactly the kind of change
   * that could break it.
   */
  for (const p of players) {
    if (!p.id) throw new Error(`emit: player '${p.handle}' has an empty id`);
  }
  if (playerIds.size !== players.length) {
    const seenIds = new Set<string>();
    const dupe = players.find((p) => seenIds.size === seenIds.add(p.id).size);
    throw new Error(`emit: duplicate player id '${dupe?.id}' in the registry`);
  }
  const sourceIds = new Set<string>(CHANNELS.map((c) => c.source));
  if (replays.length !== records.length)
    throw new Error(`emit: replay count ${replays.length} !== record count ${records.length}`);
  for (const r of replays) {
    if (r.sides.length !== 2) throw new Error(`emit: ${r.id} lost its two-sides invariant`);
    for (const s of r.sides) {
      // 1..N, not exactly-1: a set VOD's side holds every character it played
      // (see MatchSide). ZERO is still a hard fail and is the case that
      // actually matters — it is what an unresolved charactersFromFootage
      // record would look like if one ever escaped the review queue into the
      // emitted substrate.
      if (s.characters.length < 1) throw new Error(`emit: ${r.id} has a side with no character`);
      if (new Set(s.characters).size !== s.characters.length)
        throw new Error(`emit: ${r.id} side repeats a character (${s.characters.join(',')})`);
      for (const c of s.characters) {
        if (!rosterIds.has(c)) throw new Error(`emit: ${r.id} references unknown character '${c}'`);
      }
      if (!playerIds.has(s.player))
        throw new Error(`emit: ${r.id} references unknown player '${s.player}'`);
      if (s.rank && !RANK_SET.has(s.rank))
        throw new Error(`emit: ${r.id} carries off-ladder rank '${s.rank}'`);
    }
    if (!sourceIds.has(r.source))
      throw new Error(`emit: ${r.id} references untracked source '${r.source}'`);
  }
  if (genericStats.totals.replays !== records.length)
    throw new Error('emit: stats.totals.replays drifted from the record count');
  // characterUsage counts CHARACTER appearances per side, so the expected total
  // is the COMPUTED sum of every side's list length — NOT records × 2. Those
  // agree for every title-parsed record (one character per side) and diverge
  // exactly when a set VOD records a counter-pick, which is the case a
  // hardcoded × 2 would have turned into a spurious hard failure.
  const usageTotal = Object.values(stats.characterUsage).reduce((a, b) => a + b, 0);
  const expectedUsage = records.reduce(
    (n, r) => n + r.sides.reduce((m, s) => m + s.characters.length, 0),
    0,
  );
  if (usageTotal !== expectedUsage)
    throw new Error(
      `emit: characterUsage sums to ${usageTotal}, expected ${expectedUsage} character appearances`,
    );
  // every emitted patch token must be an era key or a declared boundary
  // version, and a fine token's release-date season must equal the record's —
  // the invariant the grouped facet's counts depend on. (parse normalizes;
  // a hand-edited override that breaks this fails HERE, loudly — re-run parse.)
  const patchTable = loadPatchTable(DATA);
  const knownVersions = new Set(patchTable.patches.map((p) => p.version));
  for (let i = 0; i < replays.length; i++) {
    const token = replays[i]!.patch!;
    if (/^S\d+$/.test(token)) continue;
    if (!knownVersions.has(token))
      throw new Error(`emit: ${replays[i]!.id} carries unknown patch token "${token}"`);
    if (patchTable.seasonOfPatch(token) !== records[i]!.season)
      throw new Error(
        `emit: ${replays[i]!.id} patch ${token} contradicts season ${records[i]!.season}`,
      );
  }

  // ── the shell selector's payload (Phase 6) ───────────────────────────────
  // Tiny, and fetched same-origin by the apex selector through its /tekken
  // rewrite — so it has to be COMMITTED (Vercel never runs the pipeline);
  // data/summary.json is the committed artifact and the build's build:before
  // hook copies it into public/data/ alongside the whale.
  //
  // `updated` is the newest replay's DATE, never build time. A build timestamp
  // would rewrite this file on a zero-new-video day and defeat the cron's
  // commit guard, turning every no-op day into a commit and a deploy.
  const newest = records.reduce((max, v) => (v.publishedAt > max ? v.publishedAt : max), '');
  // The counts are READ FROM the stats artifact rather than re-derived, so the
  // selector and the site's own stats page cannot disagree by construction.
  // (Re-deriving them here and asserting equality would compare `players.length`
  // with `players.length` — a throw that can never fire is not a gate.) What
  // follows are the two comparisons that CAN fire; `updated` gets its real teeth
  // in scripts/e2e.ts, which recomputes it from the substrate independently.
  const summary = {
    game: GAME_ID,
    name: GAME_NAME,
    replays: genericStats.totals.replays,
    players: genericStats.totals.players,
    characters: genericStats.totals.characters,
    updated: newest.slice(0, 10),
  };
  if (summary.replays !== replays.length)
    throw new Error(
      `emit: summary.replays ${summary.replays} !== emitted replay count ${replays.length}`,
    );
  if (summary.players < 1 || summary.characters < 1)
    throw new Error(
      `emit: summary has an empty registry (players ${summary.players}, characters ${summary.characters})`,
    );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(summary.updated))
    throw new Error(`emit: summary.updated is not a replay date ("${summary.updated}")`);

  await writeFile(join(DATA, 'replays.json'), JSON.stringify(replays) + '\n', 'utf8');
  await writeFile(join(DATA, 'stats.json'), JSON.stringify(genericStats, null, 2) + '\n', 'utf8');
  await writeFile(join(DATA, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  // the UI's season→patch hierarchy, derived from the SAME authority as the
  // tokens above so config and derivation can never drift (app.config imports
  // this committed artifact — Vercel builds never run the pipeline)
  await writeFile(
    join(DATA, 'patchGroups.json'),
    JSON.stringify(patchTable.buildPatchGroups(), null, 2) + '\n',
    'utf8',
  );

  // local-dev convenience copy (gitignored) — the build's build:before hook
  // performs the same copy on Vercel
  const pub = join(root, 'public/data');
  mkdirSync(pub, { recursive: true });
  await writeFile(join(pub, 'replays.json'), JSON.stringify(replays) + '\n', 'utf8');
  await writeFile(join(pub, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  const rankSides = replays.reduce((n, r) => n + r.sides.filter((s) => s.rank).length, 0);
  console.log(
    `✔ Emitted generic schema → data/replays.json (${replays.length}) + data/stats.json ` +
      `(characters ${characters.length} · players ${players.length} · patches ${Object.keys(genericStats.byPatchUsage).join(',')} · ` +
      `ranked sides ${rankSides}/${replays.length * 2})`,
  );
  console.log(`  summary.json → ${summary.replays} replays, newest ${summary.updated}`);
}

// ── standalone: re-derive generic files from the committed artifacts ─────────
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
  if (!existsSync(join(root, 'data/videos.json'))) {
    console.error('✖ data/videos.json missing — run the pipeline first (npm run data:build).');
    process.exit(1);
  }
  const all = await readJson<MatchVideo[]>(join(root, 'data/videos.json'));
  const overrides = await readJson<Record<string, VideoOverride>>(
    join(root, 'data/overrides.json'),
  ).catch(() => ({}));
  const records = applyOverrides(all, overrides);
  /**
   * RESOLVE AFTER OVERRIDES, exactly as parse.ts does. An override stores its
   * whole `sides` array INCLUDING the derived `player` id — a snapshot of what
   * the handle slugged to the day a person wrote the verdict — and that id goes
   * stale the moment identity resolution changes which spelling is canonical. A
   * verdict written when "KingReyJr" was its own player carries
   * `player: 'kingreyjr'`; the registry now says `king-rey-jr`, and this entry
   * point reintroduced the dead id and threw on emit's own contract. The handle
   * is the authority; the id is derived from it at every entry point.
   */
  const { resolvePlayers } = await import('./players');
  resolvePlayers(records);
  const characters = await readJson<CharacterRecord[]>(join(root, 'data/characters.json'));
  const players = await readJson<PlayerRecord[]>(join(root, 'data/players.json'));
  await emitGeneric({ records, characters, players, root });
}
