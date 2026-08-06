// SPIKE A6: can the SIDE be resolved from the footage instead of the title?
//
// THE PROBLEM THIS EXISTS FOR. The extractor reads characters by screen position
// (p1 = left crop, p2 = right crop) and the corpus supplies player handles in
// TITLE order. Pairing them assumes the title names the left player first.
// Measured over the labelled corpus, that assumption is wrong on 21 of 56
// decidable videos — 37.5%. "Evo 2026: Arslan Ash vs Rangchu" has Rangchu on
// the left. The result is a record where every character is right and every
// player is wrong, which no confidence threshold can catch because the
// character reads are perfect.
//
// THE FIX THIS PROBES. The handle is on screen too — Tekken 8's top strip
// carries it, which is why the review bands were widened to include it. And the
// job is far easier than reading a character: the two candidate handles are
// already known from the title, so this is a TWO-WAY CHOICE, not open-vocabulary
// recognition. Read the left strip, score it against both candidates, take the
// better — then vote across frames.
//
// The strips carry noise the character row does not: org tags ("VARREL",
// "TM | RB", "DRX", "NIP"), country codes ("KR", "JP", "KOR") and the round
// score. That noise is harmless here because both candidates are scored against
// the same string; it only has to favour the right one.
//
// Run: tsx scripts/spike/handle-probe.ts [--limit N]

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

import { CACHE } from '../hud-frames';
import { osa, readJson } from '../hud-read';

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

/** The two handle plates in the top strip. Wide on purpose — the plate's left
 *  edge moves with the org tag's length, so a tight box would clip the handle
 *  on exactly the sponsored players whose names matter most. */
const HANDLE_REGIONS = {
  p1: [0.1, 0.0, 0.3, 0.042],
  p2: [0.6, 0.0, 0.3, 0.042],
} as const;

const THRESHOLDS = [0, 150, 190];

const corpus = await readJson<CorpusItem[]>(join(CACHE, 'corpus.json'));
const truth = await readJson<Record<string, Label>>(join(CACHE, 'ground-truth.json'));
const extracted = await readJson<Extraction[]>(join(CACHE, 'extracted.json'));
const extById = new Map(extracted.map((e) => [e.id, e]));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const setKey = (xs: string[]) => [...new Set(xs)].sort().join(',');

async function crop(file: string, r: readonly number[], th: number): Promise<Buffer> {
  const img = sharp(file).extract({
    left: Math.round(r[0]! * 1280),
    top: Math.round(r[1]! * 720),
    width: Math.round(r[2]! * 1280),
    height: Math.round(r[3]! * 720),
  });
  const up = img.resize({ width: Math.round(r[2]! * 1280 * 4), kernel: 'lanczos3' }).greyscale();
  return (th ? up.threshold(th) : up.normalise()).png().toBuffer();
}

/** Score how well `text` contains `handle`: 0 = perfect. Uses the best window
 *  of the read rather than the whole string, because the plate carries an org
 *  tag and a country code around the handle. */
function score(text: string, handle: string): number {
  const t = norm(text);
  const h = norm(handle);
  if (!t || !h) return 99;
  if (t.includes(h)) return 0;
  let best = 99;
  for (let i = 0; i <= Math.max(0, t.length - h.length); i++) {
    for (const w of [h.length, h.length + 1, h.length + 2]) {
      const d = osa(t.slice(i, i + w), h);
      if (d < best) best = d;
    }
  }
  return best;
}

const worker = await createWorker('eng', undefined, {
  logger: () => {},
  errorHandler: () => {},
  cachePath: CACHE,
});
await worker.setParameters({ tessedit_pageseg_mode: '7' as never, debug_file: '/dev/null' });

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
  const trueLeftIsTitle0 = norm(leftSide.handle) === norm(c.handles[0]);
  if (!trueLeftIsTitle0 && norm(leftSide.handle) !== norm(c.handles[1])) continue;

  const frames = readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort();

  // Vote across frames: each frame votes for the arrangement its reads prefer.
  let votes = 0;
  for (const f of frames) {
    let a = 0; // total distance if handles[0] is on the LEFT
    let b = 0; // total distance if handles[1] is on the LEFT
    let got = false;
    for (const th of THRESHOLDS) {
      for (const side of ['p1', 'p2'] as const) {
        const { data } = await worker.recognize(await crop(join(dir, f), HANDLE_REGIONS[side], th));
        const text = data.text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const other = side === 'p1' ? 1 : 0;
        const self = side === 'p1' ? 0 : 1;
        const dSelf = score(text, c.handles[self]!);
        const dOther = score(text, c.handles[other]!);
        if (Math.min(dSelf, dOther) > 3) continue;
        got = true;
        a += dSelf;
        b += dOther;
      }
    }
    if (!got || a === b) continue;
    votes += a < b ? 1 : -1;
  }

  if (votes === 0) {
    undecided++;
    console.log(`  ? ${c.id}  undecided                       ${c.handles.join(' vs ')}`);
    continue;
  }
  decided++;
  const predictedLeftIsTitle0 = votes > 0;
  if (predictedLeftIsTitle0 === trueLeftIsTitle0) correct++;
  else {
    wrong.push(c.id);
    console.log(`  ✖ ${c.id}  predicted wrong side           ${c.handles.join(' vs ')}`);
  }
}

await worker.terminate();

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
console.log('\n── resolving the side from the HUD handle ────────────────');
console.log(
  `  decided            ${decided}/${decided + undecided}   ${pct(decided, decided + undecided)}`,
);
console.log(`  correct when decided ${correct}/${decided}   ${pct(correct, decided)}`);
console.log(`  undecided (fall back to title order) ${undecided}`);
if (wrong.length) console.log(`  wrong: ${wrong.join(', ')}`);
