// SPIKE A3: load the Evo corpus into data/review-queue.json as
// character-completion items, so /dev/source-review becomes the labelling tool.
//
// WRITES A COMMITTED FILE, DELIBERATELY LEFT UNCOMMITTED. The review UI's GET
// reads data/review-queue.json from the repo and its POST 404s any id that is
// not in that file, so a scratchpad copy cannot drive it. parse.ts regenerates
// the file wholesale every run, so `git restore data/review-queue.json` (or any
// data:parse) puts it back.
//
// The VERDICTS a labelling session produces land in data/overrides.json, which
// IS committed. Snapshot them with scripts/spike/snapshot-labels.ts before
// restoring anything — they are the expensive artifact here, not this file.
//
// Run: tsx scripts/spike/queue-evo.ts [--limit N] [--clear]

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PlayerRecord, ReviewQueueItem } from '../../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'data');
const CACHE = join(ROOT, 'cache', 'evo');

const argv = process.argv.slice(2);
const limit = Number(argv[argv.indexOf('--limit') + 1] ?? 0);
const clear = argv.includes('--clear');

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;

if (clear) {
  await writeFile(join(DATA, 'review-queue.json'), '[]\n', 'utf8');
  console.log('✔ data/review-queue.json reset to []');
  process.exit(0);
}

interface CorpusItem {
  id: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  event: string;
  round: string | null;
  handles: [string, string];
}

const corpus = await readJson<CorpusItem[]>(join(CACHE, 'corpus.json'));
const players = await readJson<PlayerRecord[]>(join(DATA, 'players.json'));

// ── player identity: the duplicate-player-page guard ─────────────────────────
// A verdict writes `player: slug(handle)`, so it lands on an EXISTING player
// page only when that slug already exists in players.json. Pre-fill the form
// with the corpus's own spelling wherever it does, and fall back to Evo's
// spelling only when the player is genuinely new.
//
// Tekken's identity rule is weaker than SF6's and this is where it shows. SF6
// keys on `idKey` — the handle with EVERY non-alphanumeric removed — so
// "MenaRD" and "Mena RD" collapse to one page. Tekken keys on `slug`, which
// maps non-alphanumerics to hyphens instead of dropping them, so "Arslan Ash"
// → arslan-ash and "ArslanAsh" → arslanash are two different pages. That
// difference cannot be fixed here (changing the identity rule would rewrite
// every existing player id), so instead it is MEASURED: anything that matches
// under the looser key but not the exact slug is a near-miss that would mint a
// duplicate page, and is reported by id so it can be resolved by hand.
// Handle VARIANTS, which no normalization can catch: a suffix is not a spelling
// difference. Evo writes "Ninjakilla_212" (the player's full FGC handle); the
// four tracked Tekken channels all write "Ninjakilla", which already owns 102
// replays. Without this the Evo verdicts would slug to `ninjakilla-212` and
// build a second page for the same competitor.
//
// CURATED, NOT INFERRED — the same discipline ORG_PREFIXES documents in
// parse.ts, and for the same reason: a wrong merge silently rewrites a real
// player's page, so entries earn their place by being recognizable. Delete a
// line to undo one merge.
const HANDLE_ALIASES = new Map<string, string>([
  ['ninjakilla_212', 'Ninjakilla'], // Evo 2026 Losers Round 1 vs JeonDDing
]);

const slug = (handle: string): string =>
  handle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const loose = (handle: string): string => handle.toLowerCase().replace(/[^a-z0-9]+/g, '');

const bySlug = new Map<string, PlayerRecord>();
const byLoose = new Map<string, PlayerRecord[]>();
for (const p of players) {
  bySlug.set(p.id, p);
  const k = loose(p.handle);
  byLoose.set(k, [...(byLoose.get(k) ?? []), p]);
}

let matched = 0;
let nearMiss = 0;
let novel = 0;
const nearMisses: string[] = [];

let aliased = 0;
const resolve = (raw: string, videoId: string): string => {
  const alias = HANDLE_ALIASES.get(raw.toLowerCase());
  const h = alias ?? raw;
  if (alias) aliased++;
  const exact = bySlug.get(slug(h));
  if (exact) {
    matched++;
    return exact.handle;
  }
  const near = byLoose.get(loose(h));
  if (near?.length) {
    nearMiss++;
    nearMisses.push(
      `${videoId}  "${h}" → slug ${slug(h)}  vs existing ${near.map((p) => p.id).join('/')}`,
    );
    // Adopt the existing player's spelling: it slugs to the existing id, which
    // is the entire point of the guard.
    return near[0]!.handle;
  }
  novel++;
  return h;
};

const items: ReviewQueueItem[] = (limit > 0 ? corpus.slice(0, limit) : corpus).map((c) => ({
  id: c.id,
  kind: 'character-completion' as const,
  channel: 'evoEvents' as const,
  title: c.title,
  publishedAt: c.publishedAt,
  durationSec: c.durationSec,
  handles: [resolve(c.handles[0], c.id), resolve(c.handles[1], c.id)] as [string, string],
  reason: 'no title or description on this channel names a character',
}));

items.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));

await writeFile(join(DATA, 'review-queue.json'), JSON.stringify(items, null, 2) + '\n', 'utf8');

const total = items.length * 2;
console.log(`✔ data/review-queue.json — ${items.length} character-completion items`);
console.log(`\n── player identity match rate (${total} sides) ──`);
console.log(`  exact slug match      ${matched}/${total}`);
console.log(`  via curated alias     ${aliased}/${total}`);
console.log(`  near-miss (adopted)   ${nearMiss}/${total}`);
console.log(`  genuinely new player  ${novel}/${total}`);
if (nearMisses.length) {
  console.log('\n  near-misses — would have minted a duplicate page without the guard:');
  for (const n of nearMisses) console.log(`    ${n}`);
}
console.log('\n  UNCOMMITTED ON PURPOSE — restore with: git restore data/review-queue.json');
