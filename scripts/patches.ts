// The season→patch boundary authority (parse/emit support). Validates
// data/patchBoundaries.json against the season table, computes each patch's
// window, and exposes the derivation for a video's patch plus the UI's
// patchGroups. Seasons themselves stay authoritative in parse.ts's SEASONS
// const (persisted to data/seasonBoundaries.json, which the standalone emit
// reads via loadPatchTable).
//
// ACCURACY BASIS for deriving the patch from publishedAt alone: Bandai's
// standard patch-note boilerplate (verified on Ver. 3.00.01, 2026-03-26) —
// "Replay data created before the update will no longer be playable", and
// online replay data is deleted outright. A replay can only be captured while
// its patch is live, hotfixes included, so capture date ⇒ played patch; only
// upload lag (~1-2 days on the daily channels) blurs a boundary week. The
// season-level label grace in parse.ts covers exactly those cases — a
// grace-flipped season contradicts the date-derived patch, and the normalize
// step nulls patchVersion ("season known, patch unknown").

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PatchBoundary, SeasonBoundary } from '../types/index';

export interface PatchWindow extends PatchBoundary {
  /** exclusive end: next patch's start | season end | null (open) */
  end: string | null;
  season: number;
}

export interface PatchTable {
  seasons: SeasonBoundary[];
  patches: PatchWindow[];
  /** released patch live on an ISO day (null = before the first patch) */
  patchForDate(day: string): PatchWindow | null;
  /** season a patch token belongs to (by release date) */
  seasonOfPatch(version: string): number | null;
  /** GameConfig.patchGroups: one parent per season (no pre-launch era) */
  buildPatchGroups(): {
    id: string;
    note?: string;
    children?: { id: string; note?: string }[];
  }[];
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** folded token form — the X.YY.ZZ→X.YY fold rule made mechanical */
const FOLDED = /^\d+\.\d{2}$/;
/** era-key collision guard: a patch token must never look like a parent token */
const ERA_TOKEN = /^(S\d+|Beta)$/i;

export function buildPatchTable(
  seasons: SeasonBoundary[],
  boundaries: PatchBoundary[],
): PatchTable {
  const errors: string[] = [];

  const seasonForDate = (day: string): number | null => {
    for (const b of seasons) {
      if (day >= b.start && (b.end === null || day < b.end)) return b.season;
    }
    return null;
  };

  // ── validation (hard errors — bad boundary data must never derive) ────────
  const seen = new Set<string>();
  for (const p of boundaries) {
    if (!ISO_DAY.test(p.start)) errors.push(`${p.version}: start "${p.start}" is not YYYY-MM-DD`);
    if (ERA_TOKEN.test(p.version)) errors.push(`${p.version}: version collides with an era token`);
    if (!FOLDED.test(p.version))
      errors.push(`${p.version}: not a folded X.YY token — fold hotfixes into their parent line`);
    if (seen.has(p.version)) errors.push(`${p.version}: duplicate version`);
    seen.add(p.version);
    for (const inc of p.includes ?? []) {
      if (seen.has(inc)) errors.push(`${p.version}: includes "${inc}" already a top-level row`);
    }
  }
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i]!.start <= boundaries[i - 1]!.start)
      errors.push(
        `${boundaries[i]!.version}: starts ${boundaries[i]!.start}, not after ${boundaries[i - 1]!.version} (${boundaries[i - 1]!.start}) — author in release order`,
      );
  }

  // nest by release date; every patch must land inside a declared season
  const patches: PatchWindow[] = boundaries.map((p) => {
    const season = seasonForDate(p.start);
    if (season === null)
      errors.push(`${p.version}: start ${p.start} is outside every season window`);
    return { ...p, season: season ?? -1, end: null };
  });

  // computed windows: next patch's start within the season | season end | open
  for (let i = 0; i < patches.length; i++) {
    const next = patches[i + 1];
    if (next && next.season === patches[i]!.season) patches[i]!.end = next.start;
    else patches[i]!.end = seasons.find((s) => s.season === patches[i]!.season)?.end ?? null;
  }

  // each patched season's opening patch starts ON the season start (todo-exempt)
  for (const s of seasons) {
    const first = patches.find((p) => p.season === s.season);
    if (first && first.start !== s.start && !first.todo)
      errors.push(
        `season ${s.season} opens ${s.start} but its first patch ${first.version} starts ${first.start}`,
      );
  }

  if (errors.length > 0) {
    console.error(`✖ ${errors.length} error(s) in patch/season boundaries:`);
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(1);
  }

  const patchForDate = (day: string): PatchWindow | null => {
    const d = day.slice(0, 10);
    for (const p of patches) {
      if (d >= p.start && (p.end === null || d < p.end)) return p;
    }
    return null;
  };

  return {
    seasons,
    patches,
    patchForDate,
    seasonOfPatch: (version) => patches.find((p) => p.version === version)?.season ?? null,
    buildPatchGroups() {
      // no pre-launch parent: the catalog starts on launch day (parse drops
      // anything earlier), so every season is a parent with patch children
      return seasons.map((s) => {
        const children = patches
          .filter((p) => p.season === s.season)
          .map((p) => ({ id: p.version, ...(p.note ? { note: p.note } : {}) }));
        return { id: `S${s.season}`, ...(children.length ? { children } : {}) };
      });
    },
  };
}

/** Load + validate from the committed files (standalone emit / reports —
 *  parse.ts passes its authoritative SEASONS const directly instead). */
export function loadPatchTable(dataDir: string): PatchTable {
  const readJson = <T>(p: string): T => JSON.parse(readFileSync(join(dataDir, p), 'utf8')) as T;
  const seasons = readJson<SeasonBoundary[]>('seasonBoundaries.json');
  const { patches } = readJson<{ patches: PatchBoundary[] }>('patchBoundaries.json');
  return buildPatchTable(seasons, patches);
}
