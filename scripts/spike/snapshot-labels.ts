// SPIKE: preserve hand-labelled ground truth out of harm's way.
//
// Labelling verdicts land in data/overrides.json — a COMMITTED file — as
// uncommitted working-tree additions. They are the most expensive artifact this
// spike produces (a human watched footage for every one), and a single
// `git restore data/overrides.json` would erase them silently. And a restore is
// not hypothetical: scripts/spike/queue-evo.ts tells you to run exactly that on
// data/review-queue.json, one tab-complete away.
//
// So: after every labelling session, copy the sides-shaped entries into
// cache/evo/ground-truth.json, MERGING rather than replacing, and let the
// accuracy pass read from the snapshot instead of the working tree.
//
// Run: tsx scripts/spike/snapshot-labels.ts            # capture new labels
//      tsx scripts/spike/snapshot-labels.ts --check    # exit 1 if any uncaptured
//      tsx scripts/spike/snapshot-labels.ts --restore  # put them back after a restore

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'data');
const CACHE = join(ROOT, 'cache', 'evo');
const SNAPSHOT = join(CACHE, 'ground-truth.json');

const checkOnly = process.argv.includes('--check');
const restore = process.argv.includes('--restore');

const readJson = async <T>(p: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

interface Side {
  player: string;
  handle: string;
  /** every character this side played across the set, first-appearance order */
  characters: string[];
}
interface OverrideEntry {
  '//'?: string;
  sides?: Side[];
  exclude?: boolean;
  resolvedBy?: string;
}
type Label = { sides: Side[]; note?: string; at: string };

/** Identity of a labelled side, order-insensitive: [jin, kazuya] and
 *  [kazuya, jin] are the same set of characters played, and only the SET is the
 *  claim — the stored order is presentational (first-appearance). */
const sortedChars = (s: Side) => [...(s.characters ?? [])].sort().join(',');
const key = (s: Side[]) => s.map((x) => `${x.player}:${sortedChars(x)}`).join('|');

/** data/overrides.json stores non-ASCII escaped; writing it literally would
 *  reformat every line containing one. Same escaping the review POST uses. */
const serialize = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(
    /[\u0080-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  ) + '\n';

const overrides = await readJson<Record<string, OverrideEntry>>(join(DATA, 'overrides.json'), {});
const snapshot = await readJson<Record<string, Label>>(SNAPSHOT, {});

const corpusIds = new Set(
  (await readJson<{ id: string }[]>(join(CACHE, 'corpus.json'), [])).map((c) => c.id),
);

// ── --restore: snapshot → overrides.json ─────────────────────────────────────
// The reverse direction, and the reason the snapshot is protection rather than
// an archive. Merges per id (so a hand-edited "//" on the same entry survives)
// and never touches ids the snapshot does not know about.
if (restore) {
  let put = 0;
  for (const [id, label] of Object.entries(snapshot)) {
    const prev = overrides[id];
    if (prev?.sides && key(prev.sides) === key(label.sides)) continue;
    overrides[id] = {
      ...prev,
      ...(label.note ? { '//': label.note } : {}),
      sides: label.sides,
    };
    put++;
  }
  if (put) await writeFile(join(DATA, 'overrides.json'), serialize(overrides), 'utf8');
  console.log(
    `✔ restored ${put} label(s) into data/overrides.json (${Object.keys(snapshot).length} in snapshot)`,
  );
  process.exit(0);
}

const fresh: string[] = [];
const changed: string[] = [];
for (const [id, ov] of Object.entries(overrides)) {
  if (!ov.sides || ov.sides.length !== 2) continue;
  if (!corpusIds.has(id)) continue; // only the spike's own corpus
  // An extractor-written verdict is NOT ground truth — it is the thing being
  // measured. Snapshotting one would score the extractor against itself.
  if (ov.resolvedBy === 'extractor') continue;
  const prev = snapshot[id];
  if (!prev) {
    fresh.push(id);
  } else if (key(prev.sides) !== key(ov.sides)) {
    changed.push(id);
  } else {
    continue;
  }
  snapshot[id] = {
    sides: ov.sides,
    ...(ov['//'] ? { note: ov['//'] } : {}),
    at: new Date().toISOString().slice(0, 10),
  };
}

const total = Object.keys(snapshot).length;
console.log(
  `ground truth: ${total} labelled · +${fresh.length} new · ${changed.length} revised` +
    ` · corpus ${corpusIds.size}`,
);

if (checkOnly) {
  if (fresh.length || changed.length) {
    console.error('✖ unsnapshotted labels in data/overrides.json — run without --check');
    process.exit(1);
  }
  console.log('✔ snapshot is current');
  process.exit(0);
}

await writeFile(SNAPSHOT, JSON.stringify(snapshot, null, 1) + '\n', 'utf8');
console.log(`✔ ${SNAPSHOT}`);
if (fresh.length) console.log(`  new: ${fresh.join(', ')}`);
