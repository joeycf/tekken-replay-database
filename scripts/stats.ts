// Aggregate stats over parsed MatchVideos — extracted so parse.ts and the
// standalone generic emitter (scripts/emit.ts) derive IDENTICAL numbers from
// the same records (the 2XKO pipeline's discipline). Any change to counting
// rules happens here, once.
//
// `characterUsage` counts CHARACTER appearances per side (a Kazuya mirror adds
// 2 — the engine contract's documented unit), so usage bars, per-patch
// timelines, and player-character tables all share the same denominator. That
// is side-appearances for every title-parsed record, whose sides name one
// character each, and diverges from records × 2 exactly when a tournament SET
// records a counter-pick — see MatchSide.
// The duo-only keys (pairingUsage / playerPairings) are deliberately absent:
// every engine duo panel hides itself when charactersPerSide === 1.

import type { MatchVideo } from '../types/index';

export interface PipelineStats {
  characterUsage: Record<string, number>;
  bySeasonUsage: Record<string, Record<string, number>>; // season key '1'|'2'|'3'
  playerCharacters: Record<string, Record<string, number>>;
  totals: { videos: number; bySeason: Record<string, number> };
}

const inc = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);

export function buildStats(records: MatchVideo[]): PipelineStats {
  const stats: PipelineStats = {
    characterUsage: {},
    bySeasonUsage: {},
    playerCharacters: {},
    totals: { videos: records.length, bySeason: {} },
  };
  for (const v of records) {
    const sk = String(v.season);
    inc(stats.totals.bySeason, sk);
    stats.bySeasonUsage[sk] ??= {};
    for (const side of v.sides) {
      stats.playerCharacters[side.player] ??= {};
      // Every character the side played counts. A set where one player
      // counter-picked contributes to BOTH characters' usage, which is what a
      // usage bar should show — the alternative (count only the first) would
      // silently under-report every counter-pick in the tournament corpus.
      for (const c of side.characters) {
        inc(stats.characterUsage, c);
        inc(stats.bySeasonUsage[sk], c);
        inc(stats.playerCharacters[side.player], c);
      }
    }
  }
  return stats;
}

// Deterministic key ordering for stable diffs.
export const sort1 = (o: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
export const sort2 = (
  o: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> =>
  Object.fromEntries(
    Object.entries(o)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sort1(v)]),
  );
