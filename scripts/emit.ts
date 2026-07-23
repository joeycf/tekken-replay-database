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
//   public/data/replays.json                      → EMITTED copy (gitignored;
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
  characters: string[]; // length 1 — Tekken is 1v1
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
}

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
      characters: [s.character],
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
  const sourceIds = new Set<string>(CHANNELS.map((c) => c.source));
  if (replays.length !== records.length)
    throw new Error(`emit: replay count ${replays.length} !== record count ${records.length}`);
  for (const r of replays) {
    if (r.sides.length !== 2) throw new Error(`emit: ${r.id} lost its two-sides invariant`);
    for (const s of r.sides) {
      if (s.characters.length !== 1)
        throw new Error(`emit: ${r.id} side has ${s.characters.length} characters (Tekken is 1v1)`);
      if (!rosterIds.has(s.characters[0]!))
        throw new Error(`emit: ${r.id} references unknown character '${s.characters[0]}'`);
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

  await writeFile(join(DATA, 'replays.json'), JSON.stringify(replays) + '\n', 'utf8');
  await writeFile(join(DATA, 'stats.json'), JSON.stringify(genericStats, null, 2) + '\n', 'utf8');
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

  const rankSides = replays.reduce((n, r) => n + r.sides.filter((s) => s.rank).length, 0);
  console.log(
    `✔ Emitted generic schema → data/replays.json (${replays.length}) + data/stats.json ` +
      `(characters ${characters.length} · players ${players.length} · patches ${Object.keys(genericStats.byPatchUsage).join(',')} · ` +
      `ranked sides ${rankSides}/${replays.length * 2})`,
  );
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
  const characters = await readJson<CharacterRecord[]>(join(root, 'data/characters.json'));
  const players = await readJson<PlayerRecord[]>(join(root, 'data/players.json'));
  await emitGeneric({ records, characters, players, root });
}
