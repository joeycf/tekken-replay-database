// SPIKE A5: score the extractor against the hand-labelled ground truth.
//
// Reads the SNAPSHOT (cache/evo/ground-truth.json), not data/overrides.json, so
// the measurement never depends on the working tree staying dirty.
//
// SCORING UNIT: the SET of characters a side played across the set. A label of
// [jin, kazuya] and a prediction of [kazuya, jin] agree — order is
// presentational (first-appearance), the claim is the set. The headline is
// BOTH-SIDES-EXACT: one wrong side is a wrong replay, so per-side accuracy
// flatters the thing that actually matters.
//
// The prediction is the union `foldSide` emits, read straight off
// extracted.json — this file never re-derives it, so the rule for what counts
// as played (a contiguous run of sampled frames) lives in exactly one place.
//
// THE THRESHOLD IS MEASURED HERE, NOT INHERITED. SF6 locked 0.90 against its own
// corpus and explicitly called it a prudence margin rather than a tuned value.
// Tekken gets its own curve on its own footage; the sweep below is deliberately
// finer than SF6's six points so the knee is locatable rather than assumed.
//
// Run: tsx scripts/spike/accuracy.ts

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CACHE } from '../hud-frames';
import type { Extraction } from './extract-chars';

interface Side {
  player: string;
  handle: string;
  characters: string[];
}
type Label = { sides: Side[]; note?: string; at: string };

const readJson = async <T>(p: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const truth = await readJson<Record<string, Label>>(join(CACHE, 'ground-truth.json'), {});
const extracted = await readJson<Extraction[]>(join(CACHE, 'extracted.json'), []);
const byId = new Map(extracted.map((e) => [e.id, e]));

/** Videos whose extractor prediction was VISIBLE to the labeller before they
 *  labelled, and whose labels are therefore not blind.
 *
 *  The corpus was extracted while the harness was being built, and the build
 *  log surfaced per-video predictions: three recon frames were displayed as
 *  images, a smoke test printed one result, progress lines printed several
 *  more, and the multi-character and shaky-side summaries named the rest. That
 *  is 19 of 63 — too many to wave away and too few to invalidate the run.
 *
 *  Blindness is the entire basis of the accuracy claim, so the honest fix is to
 *  report BOTH numbers: the whole corpus, and the subset that was never shown.
 *  If the two agree, exposure did not matter; if the unexposed subset scores
 *  materially worse, the headline was flattered and the unexposed number is the
 *  real one. This is a caveat with a measurement attached rather than a
 *  footnote. */
const EXPOSED = new Set([
  'FsbLumb6iuU', // recon frame shown + progress line
  'QGRjiOfPCtQ', // recon frame shown
  'Let0_1UY6fQ', // recon frame shown + smoke test
  'aoLFvn0LRO8', // progress line
  'ylRyKzVcfPY', // progress line + multi-character summary
  '4KhttuouEW4', // multi-character summary
  'qNhjjvaXyII',
  'a4IkUcphIig',
  'nMoUdGdL3C8',
  'I1VKVOiu03s',
  'n38QoGY33yE',
  'Ea5pGcudoXA',
  'JS9kQQ3CI2Q',
  'uGcUrpwTtHE',
  '0eYwQ51XwOs', // shaky-side summary
  'tvqjFbTyxpA',
  'BjaQASUORjQ',
  'oawl9W1QlAk',
  'K4ZQtV-rTRU', // tail of the run log
]);

const setKey = (xs: string[]) => [...new Set(xs)].sort().join(',');

/** THE SIDES ARE COMPARED AS AN UNORDERED PAIR, and that is a deliberate
 *  narrowing of what this number claims.
 *
 *  Neither array is in a trustworthy order:
 *
 *   · The extraction's p1/p2 are SCREEN positions (left/right crop).
 *   · The corpus `handles` are TITLE order — and measured over this corpus, the
 *     title order is REVERSED relative to the screen on 21 of 56 decidable
 *     videos (37.5%). "Evo 2026: Arslan Ash vs Rangchu" has Rangchu on the left.
 *   · The label's sides[] are in whatever order the reviewer left the form in,
 *     which followed the screen on some videos and the pre-fill on others.
 *
 *  So a positional comparison and a handle-aligned comparison BOTH measure the
 *  reviewer's data-entry order as much as the extractor. Matching the two
 *  character-sets as an unordered pair measures exactly the claim the reader
 *  can actually support: "these two character-sets are in this video".
 *
 *  WHICH PLAYER PLAYED WHICH IS A SEPARATE, UNSOLVED PROBLEM — see the
 *  attribution section below. It is not folded into this number, because doing
 *  so would hide it. */
const setKeyOf = (xs: string[]) => [...new Set(xs)].sort().join(',');
const pairKeyOf = (a: string[], b: string[]) => [setKeyOf(a), setKeyOf(b)].sort().join(' | ');

const scored = Object.entries(truth)
  .filter(([id]) => byId.has(id))
  .map(([id, label]) => {
    const e = byId.get(id)!;
    return {
      id,
      event: e.event,
      want: [label.sides[0]!.characters ?? [], label.sides[1]!.characters ?? []] as [
        string[],
        string[],
      ],
      got: [e.p1.characters, e.p2.characters] as [string[], string[]],
      conf: [e.p1.confidence, e.p2.confidence] as [number, number],
      shaky: [e.p1.shaky, e.p2.shaky] as [boolean, boolean],
      handles: e.handles,
      labelSides: label.sides,
    };
  });

if (!scored.length) {
  console.error(
    `✖ nothing to score — ${Object.keys(truth).length} labels, ${extracted.length} extractions, 0 overlap.\n` +
      '  Label items at /dev/source-review, then run scripts/spike/snapshot-labels.ts.',
  );
  process.exit(1);
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
/** Both character-sets present, in either arrangement. */
const bothOk = (s: (typeof scored)[number]) =>
  pairKeyOf(s.got[0], s.got[1]) === pairKeyOf(s.want[0], s.want[1]);
/** Per-side, after choosing the arrangement that fits best — so a correct read
 *  in the opposite arrangement scores as two hits, not two misses. */
const orient = (s: (typeof scored)[number]): 0 | 1 =>
  setKey(s.got[0]) === setKey(s.want[0]) || setKey(s.got[1]) === setKey(s.want[1]) ? 0 : 1;
const sideOk = (s: (typeof scored)[number], i: 0 | 1) =>
  orient(s) === 0
    ? setKey(s.got[i]) === setKey(s.want[i])
    : setKey(s.got[i]) === setKey(s.want[i === 0 ? 1 : 0]);

// ── headline ────────────────────────────────────────────────────────────────
const sideHits = scored.flatMap((s) => [sideOk(s, 0), sideOk(s, 1)]);
const bothHits = scored.filter(bothOk);

console.log(`\n── scored against ${scored.length} hand-labelled videos ──────────`);
console.log('  (sides matched as an unordered pair — see the note above scored[])');
console.log(
  `  both-sides-exact   ${String(bothHits.length).padStart(3)}/${scored.length}   ${pct(bothHits.length, scored.length)}`,
);
console.log(
  `  per-side           ${String(sideHits.filter(Boolean).length).padStart(3)}/${sideHits.length}   ${pct(sideHits.filter(Boolean).length, sideHits.length)}`,
);
console.log(
  `  sides reading none ${String(scored.flatMap((s) => s.got).filter((g) => !g.length).length).padStart(3)}`,
);

// ── player attribution ──────────────────────────────────────────────────────
// Reading the characters is only half a record. The other half is WHICH PLAYER
// played which, and the extractor currently infers that from the title's word
// order — which this corpus says is wrong more than a third of the time.
//
// Measured only on videos whose characters were read correctly and whose two
// sides differ (a mirror match carries no signal about orientation).
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, '');
let titleRight = 0;
let titleReversed = 0;
const reversed: string[] = [];
for (const s of scored) {
  if (!bothOk(s)) continue;
  if (setKey(s.got[0]) === setKey(s.got[1])) continue; // mirror
  const leftLabel = s.labelSides.find((x) => setKey(x.characters) === setKey(s.got[0]));
  if (!leftLabel) continue;
  if (norm(leftLabel.handle) === norm(s.handles[0] ?? '')) titleRight++;
  else if (norm(leftLabel.handle) === norm(s.handles[1] ?? '')) {
    titleReversed++;
    reversed.push(s.id);
  }
}
const decidable = titleRight + titleReversed;
console.log('\n── player attribution (the title-order assumption) ───────');
console.log(
  `  title order IS screen order    ${String(titleRight).padStart(3)}/${decidable}   ${pct(titleRight, decidable)}`,
);
console.log(
  `  title order is REVERSED        ${String(titleReversed).padStart(3)}/${decidable}   ${pct(titleReversed, decidable)}`,
);
if (titleReversed) {
  console.log(
    `\n  ✖ BLOCKING: pairing title-order handles with screen-order characters\n` +
      `    mis-attributes ${pct(titleReversed, decidable)} of records — every character correct,\n` +
      `    every player wrong. The side must be resolved from the footage\n` +
      `    (the handle is in the HUD's top strip), not from the title.`,
  );
}

// ── blind subset ────────────────────────────────────────────────────────────
// The headline above includes videos whose prediction the labeller had already
// seen (see EXPOSED). This is the number that is actually blind.
const blind = scored.filter((s) => !EXPOSED.has(s.id));
const exposed = scored.filter((s) => EXPOSED.has(s.id));
console.log('\n── blindness ─────────────────────────────────────────────');
console.log(
  `  BLIND (never shown)  ${String(blind.filter(bothOk).length).padStart(3)}/${blind.length}   ${pct(blind.filter(bothOk).length, blind.length)}   ← the honest headline`,
);
console.log(
  `  prediction was shown ${String(exposed.filter(bothOk).length).padStart(3)}/${exposed.length}   ${pct(exposed.filter(bothOk).length, exposed.length)}`,
);
if (blind.length && exposed.length) {
  const d =
    (100 * blind.filter(bothOk).length) / blind.length -
    (100 * exposed.filter(bothOk).length) / exposed.length;
  console.log(
    `  gap ${d >= 0 ? '+' : ''}${d.toFixed(1)}pp — ${Math.abs(d) < 5 ? 'exposure did not move the number' : 'EXPOSURE MATTERED; trust the blind row'}`,
  );
}

// ── the multi-character subset, reported separately ─────────────────────────
// This is the population the union design exists for; it is the number that
// says whether the design earned its keep.
const multiScored = scored.filter((s) => s.want[0].length > 1 || s.want[1].length > 1);
const singleScored = scored.filter((s) => s.want[0].length === 1 && s.want[1].length === 1);
console.log('\n── by label shape ────────────────────────────────────────');
console.log(
  `  single-character sides   ${String(singleScored.filter(bothOk).length).padStart(3)}/${singleScored.length}   ${pct(singleScored.filter(bothOk).length, singleScored.length)}`,
);
console.log(
  `  a side played 2+         ${String(multiScored.filter(bothOk).length).padStart(3)}/${multiScored.length}   ${pct(multiScored.filter(bothOk).length, multiScored.length)}`,
);

// ── how the misses fail ─────────────────────────────────────────────────────
let missedChar = 0; // label has a character the union lacks
let extraChar = 0; // union has a character the label lacks
for (const s of scored) {
  for (const i of [0, 1] as const) {
    if (sideOk(s, i)) continue;
    const want = new Set(s.want[i]);
    const got = new Set(s.got[i]);
    if ([...want].some((c) => !got.has(c))) missedChar++;
    if ([...got].some((c) => !want.has(c))) extraChar++;
  }
}
console.log(
  `\n── the ${sideHits.filter((h) => !h).length} missed sides ────────────────────────────`,
);
console.log(`  missed a character the label has   ${missedChar}`);
console.log(`  invented one the label lacks       ${extraChar}`);
console.log(
  `  sides with a too-thin read dropped ${scored.filter((s) => s.shaky[0] || s.shaky[1]).length}`,
);

// ── the threshold curve ─────────────────────────────────────────────────────
console.log('\n── auto-accept threshold sweep ───────────────────────────');
console.log('  thresh   accepted    precision   corpus coverage');
const corpusUnion = extracted.map((e) => [e.p1.confidence, e.p2.confidence]);
const GRID = [0.01, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0];
const rows = GRID.map((t) => {
  const accepted = scored.filter((s) => s.conf[0] >= t && s.conf[1] >= t);
  const correct = accepted.filter(bothOk);
  const precision = accepted.length ? correct.length / accepted.length : 1;
  const corpusAccepted = corpusUnion.filter((c) => c[0]! >= t && c[1]! >= t).length;
  return { t, accepted: accepted.length, correct: correct.length, precision, corpusAccepted };
});
for (const r of rows) {
  console.log(
    `  ${r.t.toFixed(2)}     ${String(r.accepted).padStart(3)}/${scored.length}      ` +
      `${pct(r.correct, r.accepted).padStart(6)}      ` +
      `${pct(r.corpusAccepted, extracted.length).padStart(6)} (${r.corpusAccepted}/${extracted.length})`,
  );
}

// The recommendation: the LOWEST threshold that still holds 100% precision on
// the labelled set, which is the knee — going lower buys coverage by admitting
// a known error, going higher costs review for no measured gain. Reported with
// its limits, because on a clean set precision is 100% everywhere and the
// number is a prudence margin rather than a tuned filter.
const clean = rows.filter((r) => r.accepted > 0 && r.precision === 1);
const knee = clean.length ? clean[0] : null;
console.log(
  knee
    ? `\n  ⇒ lowest threshold holding 100% precision: ${knee.t.toFixed(2)}\n` +
        `    ${pct(knee.corpusAccepted, extracted.length)} of the corpus auto-resolves; ` +
        `${extracted.length - knee.corpusAccepted} route to review`
    : '\n  ⇒ NO threshold reaches 100% precision on this labelled set',
);
const ninetyFive = rows.filter((r) => r.accepted > 0 && r.precision >= 0.95);
if (ninetyFive.length && knee && ninetyFive[0]!.t < knee.t) {
  console.log(
    `    (lowest holding ≥95%: ${ninetyFive[0]!.t.toFixed(2)}, ` +
      `${pct(ninetyFive[0]!.corpusAccepted, extracted.length)} coverage)`,
  );
}

// ── cost ────────────────────────────────────────────────────────────────────
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const secs = extracted.map((e) => e.cost.sec);
const bytes = extracted.map((e) => e.cost.bytes);
console.log('\n── cost ──────────────────────────────────────────────────');
console.log(
  `  ${(sum(secs) / secs.length).toFixed(0)}s and ${(sum(bytes) / bytes.length / 1e6).toFixed(1)}MB per video` +
    ` · ${(sum(secs) / 60).toFixed(0)} min and ${(sum(bytes) / 1e9).toFixed(2)} GB for ${extracted.length}`,
);

// ── every disagreement, for eyeballing ──────────────────────────────────────
const misses = scored.filter((s) => !bothOk(s));
if (misses.length) {
  console.log(`\n── disagreements (${misses.length}) ────────────────────────────`);
  for (const s of misses) {
    for (const i of [0, 1] as const) {
      if (sideOk(s, i)) continue;
      console.log(
        `  ${s.id} p${i + 1}  want [${s.want[i].join(', ')}]  got [${s.got[i].join(', ')}]` +
          `  conf ${s.conf[i].toFixed(2)}${s.shaky[i] ? '  (thin read dropped)' : ''}`,
      );
    }
  }
  console.log('\n  inspect one: tsx scripts/spike/inspect.ts <videoId> <p1|p2>');
}
