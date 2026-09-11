/**
 * ONE-OFF MIGRATION — backfill the badge label onto committed records.
 *
 * Engine v0.13.0 gave `Replay` an `event`, and buildTheaterRecords now sets it
 * on every NEW record. Committed records never regain a field on their own:
 * data/videos.json is merged add-only, so the records already in it would keep
 * printing the source's configured name forever while records ingested
 * tomorrow printed their event. This closes that gap once.
 *
 * WHERE THE TAG COMES FROM. Not the catalogue — `raw/` is gitignored and holds
 * at most the last cursor delta. It comes from the record's OWN title, which
 * fetch-theater synthesized as
 *
 *     <game> ▰ <p1> (<chars>) vs <p2> (<chars>) ▰ <tag>
 *
 * so the trailing slot is the tag verbatim. That is a derivation, so it is
 * gated rather than trusted: exactly 3 separator-delimited segments means
 * tagged, exactly 2 means untagged, and ANY other shape aborts the run.
 * Measured across every committed corpus on the platform before this was
 * written — theater titles are only ever 2 or 3 segments, and no tag contains
 * the separator. A 4-segment title would mean the grammar changed and the
 * derivation is no longer safe, so it stops rather than guessing.
 *
 * `channelName` is deliberately NOT backfilled. The uploader lives only in the
 * catalogue dump, this intake admits no untagged entry, and every committed
 * record here has a tag — so the field would render on nothing.
 *
 * SCOPE MATTERS MORE HERE than in the sibling repos. `tournament` is an
 * AGGREGATE source: replayTheater's 317 records share it with bneEsports (233)
 * and evoEvents (63), whose titles are ordinary YouTube titles carrying no
 * separator at all. Scoping on `intake` rather than `channel` is what keeps
 * this off them, and the 2-or-3-segment gate below is the second guard.
 *
 * WHAT IT PROVES BEFORE WRITING. Record count, id order, and byte-equality of
 * every record with the new keys stripped — the only difference anywhere in
 * the file is the presence of a new key. Plus the coverage counts, hard-coded:
 * a backfill that silently covers 300 of 317 looks exactly like one that worked.
 *
 * Run:  npx tsx scripts/backfill-source-label.ts          # dry run, reports
 *       npx tsx scripts/backfill-source-label.ts --write  # applies
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '../data');
const SEP = '▰';
const WRITE = process.argv.includes('--write');

/** Hard-coded from the committed corpus, so drift fails loudly. */
const EXPECT = { scoped: 317, fromTag: 317, untagged: 0 };

type Rec = Record<string, unknown> & { id: string; title: string; event?: string };

const isTheater = (r: Rec): boolean => r.intake === 'replayTheater';

function tagOf(title: string, id: string): string | null {
  const segs = title.split(SEP);
  if (segs.length === 3) {
    const t = segs[2]!.trim();
    if (!t) throw new Error(`${id}: 3-segment title with an empty tag slot — refusing to guess`);
    return t;
  }
  if (segs.length === 2) return null;
  throw new Error(
    `${id}: theater title has ${segs.length} "${SEP}" segments, expected 2 or 3. The synthesized ` +
      `title grammar changed and this derivation is no longer safe. Nothing written.`,
  );
}

const fail = (msg: string): never => {
  throw new Error(`${msg}\nNothing written.`);
};

const raw = await readFile(join(DATA, 'videos.json'), 'utf8');
// The indent is READ, never assumed. Sibling repos write this file at 1 space
// and others at 2, and a migration that guessed would reformat every line of a
// file whose whole point is that it changes add-only — burying 300 real
// insertions in a 400,000-line diff nobody can review.
const INDENT = (/^\n?([ ]+)/.exec(raw.slice(raw.indexOf('\n')))?.[1] ?? '  ').length;
const before = JSON.parse(raw) as Rec[];
const scoped = before.filter(isTheater);
let fromTag = 0;
let untagged = 0;

const after = before.map((r) => {
  if (!isTheater(r)) return r;
  const tag = tagOf(r.title, r.id);
  if (!tag) {
    untagged += 1;
    return r;
  }
  fromTag += 1;
  // Rebuilt with `event` in the slot the theater builder puts it in — just
  // before `sides` — so a backfilled record and one ingested tomorrow
  // serialize identically. `{ ...r, event }` would append it after the big
  // sides array instead, leaving the corpus in two shapes forever.
  const { sides, ...head } = r;
  return { ...head, event: tag, sides };
});

if (after.length !== before.length) fail(`record count moved: ${before.length} → ${after.length}`);
const ids = (rs: Rec[]) => JSON.stringify(rs.map((r) => r.id));
if (ids(after) !== ids(before)) fail('id order changed');

const strip = (r: Rec) => {
  const { event: _event, channelName: _channelName, ...rest } = r;
  return JSON.stringify(rest);
};
const drifted = after.filter((r, i) => strip(r) !== JSON.stringify(before[i]));
if (drifted.length)
  fail(`${drifted.length} record(s) changed beyond the new keys, e.g. ${drifted[0]!.id}`);

const labelled = after.filter((r) => r.event);
if (labelled.some((r) => !isTheater(r))) fail('a non-theater record gained a label');
if (labelled.some((r) => !(r.event ?? '').trim())) fail('an empty or blank label was written');

const longest = labelled.reduce((a, r) => Math.max(a, (r.event ?? '').length), 0);
console.log(`  scoped:    ${scoped.length}\t(expected ${EXPECT.scoped})`);
console.log(`  from tag:  ${fromTag}\t(expected ${EXPECT.fromTag})`);
console.log(`  untagged:  ${untagged}\t(expected ${EXPECT.untagged})`);
console.log(`  distinct:  ${new Set(labelled.map((r) => r.event)).size}`);
console.log(`  longest:   ${longest} chars`);

if (scoped.length !== EXPECT.scoped || fromTag !== EXPECT.fromTag || untagged !== EXPECT.untagged)
  fail('coverage does not match the measured corpus');

if (!WRITE) {
  console.log('\n✓ dry run — every assertion passed. Re-run with --write to apply.');
} else {
  await writeFile(join(DATA, 'videos.json'), `${JSON.stringify(after, null, INDENT)}\n`);
  console.log(`\n✓ wrote data/videos.json — ${fromTag} record(s) gained an event.`);
  console.log('  Now run: npm run data:emit');
}
