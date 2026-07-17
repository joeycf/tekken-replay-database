// Shared roster + ladder helpers for the parse/emit stages.
//
// Character matching: longest-alias-first whole-word search over free text
// (title paren contents, description sides) — "Armor King" wins over "King",
// "Devil Jin" over "Jin". Aliases come from data/characters.json
// (scripts/characters.ts writes short + official full names + curated
// variants), so parse vocabulary and the app's search vocabulary are the
// same data.
//
// Rank normalization: Tekken 8's ladder is the 30 named ranks
// (data/ranks.json — the single source app/app.config.ts also imports).
// Season 2 added God of Destruction sub-tiers (I–VII, ∞) ABOVE the named
// ladder as orb progression; sources write them as "God of Destruction 6" /
// "GoD ∞" — all normalized to "God of Destruction" so Side.rank always lands
// in GameConfig.ranks.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import RANKS from '../data/ranks.json';
import type { CharacterRecord } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export { RANKS };
export const RANK_SET = new Set<string>(RANKS);

export async function loadCharacters(): Promise<CharacterRecord[]> {
  const raw = await readFile(join(ROOT, 'data', 'characters.json'), 'utf8');
  const characters = JSON.parse(raw) as CharacterRecord[];
  if (characters.length === 0) {
    throw new Error('data/characters.json is empty — run `npm run data:characters` first.');
  }
  return characters;
}

export interface AliasMatch {
  id: string;
  /** [start, end) span of the alias inside the searched text. */
  start: number;
  end: number;
}

export interface AliasMatcher {
  /** All character matches in the text, longest-alias-first, overlaps
   *  suppressed (so "Devil Jin" absorbs its inner "Jin"). */
  find(text: string): AliasMatch[];
  /** The single character a side-sized fragment names, or null when the
   *  fragment names zero or 2+ characters. */
  one(text: string): string | null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildAliasMatcher(characters: CharacterRecord[]): AliasMatcher {
  // alias → id, longest first so greedy scanning prefers the longest name
  const entries: { alias: string; id: string; re: RegExp }[] = [];
  for (const c of characters) {
    const aliases = c.extra?.aliases ?? [c.name.toLowerCase()];
    for (const alias of aliases) {
      entries.push({
        alias,
        id: c.id,
        // word-ish boundaries: aliases may contain spaces/hyphens/digits
        re: new RegExp(`(?<![a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`, 'gi'),
      });
    }
  }
  entries.sort((a, b) => b.alias.length - a.alias.length);

  function find(text: string): AliasMatch[] {
    const taken: AliasMatch[] = [];
    for (const { id, re } of entries) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const span = { id, start: m.index, end: m.index + m[0].length };
        if (!taken.some((t) => span.start < t.end && t.start < span.end)) taken.push(span);
      }
    }
    return taken.sort((a, b) => a.start - b.start);
  }

  return {
    find,
    one(text: string): string | null {
      const found = find(text);
      const ids = [...new Set(found.map((f) => f.id))];
      return ids.length === 1 ? ids[0]! : null;
    },
  };
}

// ── ladder-rank extraction ───────────────────────────────────────────────────
// Longest-first ladder tokens + the GoD variants ("God/Lord of Destruction 6",
// "God of Destruction ∞"). Returns the normalized GameConfig.ranks entry.
const RANK_ALTS = [...RANKS].sort((a, b) => b.length - a.length).map(escapeRegExp);
const RANK_RE = new RegExp(
  `(?<![a-z])(?:(?:god|lord) of destruction(?:\\s*(?:[ivx]+|\\d+|∞|infinity|infinite))?|${RANK_ALTS.join('|')})(?![a-z])`,
  'i',
);

export function extractRank(text: string): string | undefined {
  const m = RANK_RE.exec(text);
  if (!m) return undefined;
  const raw = m[0].toLowerCase();
  if (raw.startsWith('god of destruction') || raw.startsWith('lord of destruction')) {
    return 'God of Destruction';
  }
  return RANKS.find((r) => r.toLowerCase() === raw);
}
