/**
 * PLAYER IDENTITY — which spellings are one person, and what that person is called.
 *
 * `slug` turns every run of punctuation into a hyphen, so "X c c" and "Xcc"
 * become two player pages, each holding some of that player's matches (155 and
 * 83 respectively) and each looking entirely correct from the inside. Measured
 * on this corpus: 110 players split that way across 578 records.
 *
 * `idKey` is the fix and it is not a new idea here — sf6-replay-database has
 * carried it since its own recon found "Ending Walker"/"EndingWalker" at 333 and
 * 296 sides, and SF6 is the only game on the platform with zero split players.
 * tokon-replay-database adopted it first; this is the same module, adapted.
 *
 * WHAT NORMALISATION CANNOT DECIDE, and therefore lives here:
 *
 *   HANDLE_ALIASES   two spellings whose ALPHANUMERICS differ — a suffix
 *                    ("Ninjakilla_212"), a typo, a spelling only another game
 *                    knows. Already existed in parse.ts for exactly this, but
 *                    was consulted ONLY in the review-queue prefill and never in
 *                    the id path; it lives here now and reaches both.
 *   DISTINCT_KEYS    one normalised key that is genuinely TWO people. Tekken is
 *                    the game that needs this: "T-Ara" (8 records) and "Tara"
 *                    (7) normalise together and are not obviously one person.
 *
 * CURATED, NEVER INFERRED — the discipline ORG_PREFIXES in parse.ts already
 * states, for the same reason: "a wrong merge silently rewrites a real player's
 * page". A wrong fighter alias shows up in a residue report; a wrong player
 * merge produces a page that looks completely normal and is wrong about who
 * played the matches.
 *
 * The detector is scripts/player-dupes.ts. It proposes; this file answers.
 */

import type { MatchVideo, PlayerRecord } from '../types/index';

/** IDENTITY — the handle reduced to its alphanumerics. Not the id. */
export const idKey = (handle: string): string => {
  const lower = handle.normalize('NFKD').toLowerCase();
  const ascii = lower.replace(/[^a-z0-9]+/g, '');
  // A handle in another script reduces to "" on the ASCII path; without this
  // fallback every non-Latin handle shares one key and the collision gate calls
  // them all the same person.
  if (ascii) return ascii;
  return lower.replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '');
};

/** The PUBLIC id, and the URL. Which SPELLING gets slugged is decided below. */
export const playerSlug = (handle: string): string => {
  const ascii = handle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii;
  return handle
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
};

/**
 * Variant `idKey` → the canonical DISPLAY HANDLE (the id is derived from it).
 *
 * Moved here from parse.ts, where it held one entry and could not reach the id
 * path that needed it.
 */
export const HANDLE_ALIASES = new Map<string, string>([
  // A suffix is not a spelling difference. Evo writes the player's full FGC
  // handle; the four Tekken channels write the short one, which already owns
  // 100+ replays. Without this the Evo verdicts slug to `ninjakilla-212` and
  // build a second page for the same competitor.
  //   Evo 2026 Losers Round 1 vs JeonDDing
  ['ninjakilla212', 'Ninjakilla'],
]);

/**
 * Normalised keys that legitimately hold more than one player.
 *
 * Every entry is a REFUSAL TO MERGE and needs the same evidence a merge would.
 * Populated from scripts/player-dupes.ts output and reviewed by hand.
 */
export const DISTINCT_KEYS = new Set<string>([
  // Generic phrases two unrelated people pick independently. Each pair shares no
  // character, never played the other, and holds 1-2 records a side — so there
  // is counter-evidence and no positive evidence, and a name anyone might type
  // is the wrong place to guess.
  'noname', //       "No Name" (Bryan) / "NONAME" (King) — a placeholder, not a person
  'ken', //          "Ken" (Clive, Steve) / "K e n" (Bob)
  'whatsky', //      "What Sky" (Bryan) / "WHATSKY" (Heihachi)
  'deathknight', //  "DEATH KNIGHT" (Shaheen) / "DeathKnight" (Leo)
  // Deliberately NOT here, though they also share no character: Triple H,
  // CD Gken, Brawlpro, DirtyStyle, Shin Moong. Those names are distinctive
  // enough that one person writing them two ways is the likelier story, and a
  // 1-record side switching character says almost nothing in a game where
  // everybody mains one.
]);

export interface MergeReport {
  /** canonical id → the ids it absorbed, for the redirect ledger. */
  merged: Map<string, string[]>;
}

/**
 * Pick the spelling that represents an identity, and rewrite every side to it.
 *
 * THE TIEBREAK, in order, each rung reached only when the one above ties:
 *
 *   1. a description spelling that is not ALL-CAPS, which parse.ts already
 *      weights at 1000× — the channels shout in titles and write properly in
 *      descriptions.
 *   2. mixed case over ALL-CAPS.
 *   3. frequency.
 *   4. fewer separators — the compact form.
 *   5. lexicographic, so a run is reproducible rather than insertion-ordered.
 *
 * Rung 5 looks like a formality and is not: without it two equally-weighted
 * spellings resolve by whichever the parser saw first, so the emitted id — a
 * live URL — depends on the order the channels happened to upload in.
 */
export function resolvePlayers(
  records: MatchVideo[],
  /**
   * id → variant → weight, as parse.ts already accumulates it (desc = 1000).
   *
   * OPTIONAL, because the other caller has no such table: `npm run data:emit`
   * reads committed data instead of re-parsing, so it has records and nothing
   * else. Derived from the records themselves when omitted — an unweighted vote,
   * which is all that is needed there because videos.json is already canonical
   * and the only un-resolved handles are the ones an override carried in.
   */
  casing?: Map<string, Map<string, number>>,
  slugOf: (handle: string) => string = playerSlug,
): MergeReport {
  casing ??= (() => {
    const m = new Map<string, Map<string, number>>();
    for (const r of records) {
      for (const s of r.sides) {
        const v = m.get(s.player) ?? new Map<string, number>();
        v.set(s.handle, (v.get(s.handle) ?? 0) + 1);
        m.set(s.player, v);
      }
    }
    return m;
  })();
  const keyOf = (handle: string): string => {
    const aliased = HANDLE_ALIASES.get(idKey(handle));
    return idKey(aliased ?? handle);
  };

  // Re-key parse.ts's per-ID casing table onto identity keys.
  const byKey = new Map<string, Map<string, number>>();
  const idsOf = new Map<string, Set<string>>();
  for (const [id, variants] of casing) {
    for (const [handle, weight] of variants) {
      const key = keyOf(handle);
      // A DECLARED-DISTINCT KEY IS NOT RESOLVED AT ALL. Skipping it here is what
      // makes the declaration mean "these are two people" rather than merely
      // "stop asking me about this" — leaving it in the ballot would merge them
      // anyway and only silence the gate, which is the failure the set exists to
      // prevent, wearing the exact shape of the fix.
      if (!key || DISTINCT_KEYS.has(key)) continue;
      const m = byKey.get(key) ?? new Map<string, number>();
      m.set(handle, (m.get(handle) ?? 0) + weight);
      // A curated alias is a human verdict, not another observation.
      const alias = HANDLE_ALIASES.get(idKey(handle));
      if (alias) m.set(alias, (m.get(alias) ?? 0) + 1_000_000);
      byKey.set(key, m);
      const ids = idsOf.get(key) ?? new Set<string>();
      ids.add(id);
      idsOf.set(key, ids);
    }
  }

  const isMixed = (h: string): boolean => /[a-z]/.test(h) && /[A-Z]/.test(h);
  const separators = (h: string): number => (h.match(/[^\p{L}\p{N}]/gu) ?? []).length;

  const best = new Map<string, string>();
  for (const [key, variants] of byKey) {
    const chosen = [...variants.entries()].sort((a, b) => {
      const [ha, wa] = a;
      const [hb, wb] = b;
      if (isMixed(ha) !== isMixed(hb)) return isMixed(ha) ? -1 : 1;
      if (wa !== wb) return wb - wa;
      const sa = separators(ha);
      const sb = separators(hb);
      if (sa !== sb) return sa - sb;
      return ha.localeCompare(hb);
    })[0]![0];
    best.set(key, chosen);
  }

  for (const r of records) {
    for (const s of r.sides) {
      const handle = best.get(keyOf(s.handle));
      if (!handle) continue;
      s.handle = handle;
      s.player = slugOf(handle);
    }
  }

  const merged = new Map<string, string[]>();
  for (const [key, ids] of idsOf) {
    const canonical = slugOf(best.get(key) ?? '');
    const absorbed = [...ids].filter((i) => i && i !== canonical).sort();
    if (absorbed.length) merged.set(canonical, absorbed);
  }
  return { merged };
}

/** Collisions the resolution did not fix — a check on this file, not the corpus. */
export function undeclaredCollisions(
  players: PlayerRecord[],
): { key: string; handles: string[] }[] {
  const by = new Map<string, string[]>();
  for (const p of players) {
    const k = idKey(p.handle);
    by.set(k, [...(by.get(k) ?? []), p.handle]);
  }
  return [...by.entries()]
    .filter(([k, hs]) => hs.length > 1 && !DISTINCT_KEYS.has(k))
    .map(([key, handles]) => ({ key, handles: handles.sort() }));
}
