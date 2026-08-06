// Do any Evo uploads duplicate a match the tournament channel already carries?
//
// WHY THIS EXISTS INSTEAD OF A DEDUPE MODULE. SF6 ships scripts/replay-dupes.ts,
// a full duplicate-resolution engine with a channel-precedence order and a
// paste-ready overrides fragment. Porting it here was considered and DEFERRED,
// because the number it would act on is currently zero:
//
//   Evo corpus 63 · tournament records 223
//   same player-pair key                       19
//   tier A (Δduration ≤ 1s, actionable)         0
//   tier B (Δduration ≤ 2s, actionable)         0
//   tier C (Δduration ≤ 90s, report-only)       6
//
// And the zero looks STRUCTURAL rather than lucky. SF6's matcher keys on
// second-exact duration because a re-upload of the same file re-encodes to the
// same length. Evo and Bandai Namco are not re-uploading each other's files:
// each captures the event independently, with its own stream overlay, its own
// intro and its own trim. Two independent captures of one match agree on the
// players and disagree on the duration by tens of seconds — which is exactly
// the shape of the 6 tier-C pairs (Δ19s to Δ79s), and exactly what tier C means
// (visible ambiguity, never auto-proposed).
//
// So this script is the MEASUREMENT without the machinery. It keeps the tier-C
// pairs visible, and it names its own trigger:
//
//   ▸ THE PORT TRIGGER: the first time this reports a tier-A or tier-B pair,
//     port scripts/replay-dupes.ts from sf6-replay-database. That is the signal
//     that the two channels have started carrying byte-comparable copies, which
//     is the only condition under which automatic resolution is safe.
//
// WHEN THAT PORT HAPPENS, it must carry SF6's precedence correction with it:
//
//   An extraction-origin `sides` override must NOT confer dedupe priority.
//   SF6's rule 1 protects a hand-authored override because dropping it would
//   strand real curation. But for a charactersFromFootage channel EVERY record
//   is a sides override — that is simply how the record exists, not corrective
//   work worth protecting. Treating it as protected makes Evo win every
//   duplicate pair and silently invert the precedence the channel list
//   declares. SF6 hit this on its FUNDA winners-final pair (2026-07-31) and
//   fixed it with a FOOTAGE_SOURCES set excluded from override protection.
//
//   On Tekken that set must key on the INTAKE CHANNEL, not the source. Evo and
//   bneEsports both publish under source 'tournament', so a source-keyed rule
//   would strip override protection from every Bandai Namco record too — and a
//   source-keyed precedence order could not tell the two channels apart at all.
//   MatchVideo.intake exists for exactly this (types/index.ts).
//
// Read-only: writes nothing, proposes nothing.
//
// Run: npm run data:evo-overlap [--json]

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MatchVideo } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const read = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;

interface CorpusItem {
  id: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  event: string;
  handles: [string, string];
}

const corpusPath = join(ROOT, 'cache/evo/corpus.json');
if (!existsSync(corpusPath)) {
  console.error('✖ cache/evo/corpus.json missing — run scripts/spike/evo-corpus.ts first.');
  process.exit(1);
}
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusItem[];
const videos = read<MatchVideo[]>('data/videos.json');

// Side-agnostic player-pair key: channels disagree about which player is
// "left". Org tags are stripped because the broadcast overlay carries them
// ("TM | RB ARSLAN ASH") and Evo's titles do not — the same fragmentation
// ORG_PREFIXES exists for in parse.ts.
const ORG = new Set([
  'aeg',
  'drx',
  'dnf',
  'kdf',
  'vit',
  'rb',
  'tm',
  'pk',
  'fal',
  'falcons',
  'varrel',
  't1',
  'gen',
  'dfm',
  'sr',
  'fw',
  'cag',
  'yg',
  'atk',
  'kor',
]);
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '');
const strip = (h: string) => {
  const parts = h.trim().split(/\s+/);
  return parts.length > 1 && ORG.has(parts[0]!.toLowerCase()) ? parts.slice(1).join(' ') : h;
};
const pairKey = (hs: string[]) =>
  hs
    .map((h) => norm(strip(h)))
    .sort()
    .join('|');

// Only channels that could plausibly carry the same event footage. Evo is a
// TEKKEN World Tour stop, so Bandai Namco's own channel is the candidate.
const EVENT_INTAKES = new Set(['bneEsports']);
const eventRecords = videos.filter((v) => EVENT_INTAKES.has(v.intake));

const byPair = new Map<string, MatchVideo[]>();
for (const v of eventRecords) {
  const k = pairKey(v.sides.map((s) => s.handle));
  byPair.set(k, [...(byPair.get(k) ?? []), v]);
}

interface Pair {
  tier: 'A' | 'B' | 'C';
  delta: number;
  evo: { id: string; durationSec: number; event: string; title: string };
  event: { id: string; durationSec: number; intake: string; title: string };
  players: string;
}

const pairs: Pair[] = [];
let samePair = 0;
for (const c of corpus) {
  const cands = byPair.get(pairKey(c.handles));
  if (!cands?.length) continue;
  samePair++;
  for (const v of cands) {
    const delta = Math.abs(v.durationSec - c.durationSec);
    if (delta > 90) continue;
    pairs.push({
      tier: delta <= 1 ? 'A' : delta <= 2 ? 'B' : 'C',
      delta,
      evo: { id: c.id, durationSec: c.durationSec, event: c.event, title: c.title },
      event: { id: v.id, durationSec: v.durationSec, intake: v.intake, title: v.title },
      players: c.handles.join(' vs '),
    });
  }
}
pairs.sort((a, b) => a.delta - b.delta);

const count = (t: Pair['tier']) => pairs.filter((p) => p.tier === t).length;
const actionable = count('A') + count('B');

if (asJson) {
  console.log(JSON.stringify({ corpus: corpus.length, samePair, pairs }, null, 2));
} else {
  console.log('── Evo ↔ tournament-channel overlap ───────────────────');
  console.log(`  Evo corpus                    ${corpus.length}`);
  console.log(`  tournament records            ${eventRecords.length}`);
  console.log(`  same player-pair key          ${samePair}`);
  console.log(`  tier A (Δ ≤ 1s, actionable)   ${count('A')}`);
  console.log(`  tier B (Δ ≤ 2s, actionable)   ${count('B')}`);
  console.log(`  tier C (Δ ≤ 90s, report-only) ${count('C')}`);
  if (pairs.length) {
    console.log('\n  pairs:');
    for (const p of pairs) {
      console.log(
        `    [${p.tier}] Δ${String(p.delta).padStart(3)}s  evo:${p.evo.id} (${p.evo.durationSec}s)` +
          `  ${p.event.intake}:${p.event.id} (${p.event.durationSec}s)  ${p.players}`,
      );
    }
  }
}

if (actionable > 0) {
  console.error(
    `\n▸ ${actionable} ACTIONABLE (tier A/B) duplicate pair(s) — this is the documented trigger\n` +
      "  to port scripts/replay-dupes.ts from sf6-replay-database. See this file's header\n" +
      '  for the precedence correction that must travel with it.',
  );
  process.exit(1);
}
