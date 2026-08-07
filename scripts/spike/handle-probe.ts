// SPIKE A6 → REGRESSION TEST: is the side resolvable from the footage?
//
// THE PROBLEM THIS EXISTS FOR. `foldSide` reads characters by SCREEN position
// and the corpus supplies handles in TITLE order. Pairing them assumes the
// title names the left player first — wrong on 23 of 61 videos here (37.7%).
// "Evo 2026: Arslan Ash vs Rangchu" has Rangchu on the left. The result is a
// record where every character is right and every player is wrong, which no
// confidence signal can catch because the character reads are perfect.
//
// THE FIX IT MEASURES now lives in scripts/hud-read.ts as `resolveSide`, and
// this file CALLS it rather than reimplementing it. That is deliberate: while
// this held its own copy, a passing score here said nothing about the shipped
// code. SF6 carries exactly that hazard — its parse.ts `footageTitle` and its
// spike's `parseEvoTitle` are two independent implementations of one algorithm.
//
// So this is now the regression test for production side resolution. If it
// stops reporting 61/61, `resolveSide` regressed.
//
// Run: tsx scripts/spike/handle-probe.ts [--limit N]

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE } from '../hud-frames';
import { makeHandleWorker, readJson, resolveSide } from '../hud-read';

const limit = Number(process.argv[process.argv.indexOf('--limit') + 1] ?? 0);

interface CorpusItem {
  id: string;
  title: string;
  handles: [string, string];
}
interface Label {
  sides: { handle: string; characters: string[] }[];
}
interface Extraction {
  id: string;
  handles: [string, string];
  p1: { characters: string[] };
  p2: { characters: string[] };
}

const corpus = await readJson<CorpusItem[]>(join(CACHE, 'corpus.json'));
const truth = await readJson<Record<string, Label>>(join(CACHE, 'ground-truth.json'));
const extracted = await readJson<Extraction[]>(join(CACHE, 'extracted.json'));
const extById = new Map(extracted.map((e) => [e.id, e]));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const setKey = (xs: string[]) => [...new Set(xs)].sort().join(',');

const worker = await makeHandleWorker();

let decided = 0;
let correct = 0;
let undecided = 0;
const wrong: string[] = [];

const work = limit > 0 ? corpus.slice(0, limit) : corpus;
for (const c of work) {
  const dir = join(CACHE, 'frames', c.id);
  if (!existsSync(dir)) continue;
  const label = truth[c.id];
  const ext = extById.get(c.id);
  if (!label || !ext) continue;

  // Ground truth for ORIENTATION, derived from the labels: which labelled side
  // owns the characters the extractor saw on the left? Skip mirrors and any
  // video whose characters were not read correctly — neither carries a signal
  // about orientation.
  if (setKey(ext.p1.characters) === setKey(ext.p2.characters)) continue;
  const leftSide = label.sides.find((s) => setKey(s.characters) === setKey(ext.p1.characters));
  const rightSide = label.sides.find((s) => setKey(s.characters) === setKey(ext.p2.characters));
  if (!leftSide || !rightSide || leftSide === rightSide) continue;
  const trueLeftIsFirst = norm(leftSide.handle) === norm(c.handles[0]);
  if (!trueLeftIsFirst && norm(leftSide.handle) !== norm(c.handles[1])) continue;

  const frames = readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => join(dir, f));

  const r = await resolveSide(worker, frames, c.handles);

  if (!r.decided) {
    undecided++;
    console.log(`  ? ${c.id}  undecided                       ${c.handles.join(' vs ')}`);
    continue;
  }
  decided++;
  if (r.leftIsFirst === trueLeftIsFirst) correct++;
  else {
    wrong.push(c.id);
    console.log(`  ✖ ${c.id}  predicted wrong side (votes ${r.votes})  ${c.handles.join(' vs ')}`);
  }
}

await worker.terminate();

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
console.log('\n── resolving the side from the HUD handle ────────────────');
console.log(
  `  decided            ${decided}/${decided + undecided}   ${pct(decided, decided + undecided)}`,
);
console.log(`  correct when decided ${correct}/${decided}   ${pct(correct, decided)}`);
console.log(`  undecided (caller must NOT auto-accept these) ${undecided}`);
if (wrong.length) console.log(`  wrong: ${wrong.join(', ')}`);
if (decided && correct === decided && !undecided) {
  console.log('\n✔ production resolveSide reproduces the measured result');
}
