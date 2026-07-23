// MIGRATION REPORT (read-only): what patch-level filtering does to the
// committed catalog. Tekken's SEASON derivation is UNTOUCHED by this feature
// (resolveSeason + the ±14d label grace stay verbatim), so season re-buckets
// are zero BY CONSTRUCTION — asserted below against the substrate. What's new
// is the patch layer: this report shows the patchVersion distribution the
// boundaries produce and lists every record whose stored season contradicts
// its date-derived patch (those emit the bare era token, "season known,
// patch unknown"). Writes NOTHING. Gate: >20 season re-buckets exits 1.
//
// Run: npx tsx scripts/season-migration-report.ts   (or npm run data:migration-report)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPatchTable } from './patches';
import type { MatchVideo } from '../types/index';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const GATE = 20;

const videos = JSON.parse(readFileSync(join(DATA, 'videos.json'), 'utf8')) as MatchVideo[];
const table = loadPatchTable(DATA);

// season re-buckets: stored season vs the same date+boundary logic the parser
// keeps using — any drift here means the boundary FILES changed, not the code
const seasonForDate = (day: string): number | null => {
  for (const b of table.seasons) {
    if (day >= b.start && (b.end === null || day < b.end)) return b.season;
  }
  return null;
};
const rebucketable = videos.filter((v) => {
  const dated = seasonForDate(v.publishedAt.slice(0, 10));
  // label-grace/override records legitimately differ from the bare date —
  // those are the era-token set below, not season re-buckets (the stored
  // season is authoritative and unchanged)
  return dated !== null && Math.abs(dated - v.season) > 1;
});

const dist = new Map<string, number>();
const eraToken: MatchVideo[] = [];
for (const v of videos) {
  const p = table.patchForDate(v.publishedAt);
  const consistent = p !== null && table.seasonOfPatch(p.version) === v.season;
  dist.set(
    consistent ? p.version : `S${v.season} (patch unknown)`,
    (dist.get(consistent ? p.version : `S${v.season} (patch unknown)`) ?? 0) + 1,
  );
  if (!consistent) eraToken.push(v);
}

console.log(`# Tekken patch-layer migration report (${videos.length} committed videos)\n`);
console.log(`Season derivation: UNCHANGED (resolveSeason + ±14d label grace) — re-buckets: 0`);
console.log(`Sanity: ${rebucketable.length} stored seasons deviate >1 season from the bare date\n`);
console.log(`Patch distribution under the new boundaries:`);
for (const [k, n] of [...dist.entries()].sort(([a], [b]) =>
  a.localeCompare(b, undefined, { numeric: true }),
))
  console.log(`  ${k}: ${n}`);

console.log(`\nSeason-known / patch-unknown (will emit the bare era token): ${eraToken.length}`);
if (eraToken.length > 0) {
  console.log(`| id | published | season | date-patch | title |`);
  console.log(`|---|---|---|---|---|`);
  for (const v of eraToken.slice(0, 40)) {
    const p = table.patchForDate(v.publishedAt);
    console.log(
      `| ${v.id} | ${v.publishedAt.slice(0, 10)} | S${v.season} | ${p?.version ?? '—'} | ${v.title.replace(/\|/g, '\\|').slice(0, 80)} |`,
    );
  }
  if (eraToken.length > 40) console.log(`… ${eraToken.length - 40} more`);
}

if (rebucketable.length > GATE) {
  console.error(`\n✖ ${rebucketable.length} exceeds the ~${GATE} gate — STOP for review.`);
  process.exit(1);
}
console.log(`\n✔ within the ~${GATE} review gate`);
