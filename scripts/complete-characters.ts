// Stage 2b: resolve `character-completion` review items by reading the footage.
//
// @EvoEvents states players, game and round in its titles but never a
// character, so parse.ts queues each match-shaped upload instead of counting it
// as a miss. This reads the HUD and writes the same verdict shape a human
// would, tagged `resolvedBy: 'extractor'` with its confidence.
//
// THREE THINGS THIS DOES THAT SF6's EQUIVALENT DOES NOT, each measured:
//
// 1. IT RESOLVES THE SIDE FROM THE FOOTAGE. The characters are read by screen
//    position and the handles arrive in title order, and on this channel those
//    disagree on 23 of 61 videos (37.7%). Pairing them positionally — which is
//    what SF6 still does — produces records where every character is right and
//    every player is wrong. `resolveSide` reads the handle plates instead:
//    61/61 on the labelled corpus.
//
// 2. AN UNDECIDED SIDE DOES NOT AUTO-ACCEPT. If the footage cannot say which
//    player is which, the attribution is a coin-flip dressed as a verdict, so
//    the item stays queued for a human however clean the character reads were.
//
// 3. IT RE-SAMPLES THIN READS. Below RESAMPLE_BELOW confidence it pulls
//    RESAMPLE_FRAMES and folds again. Four corpus videos lost a character to a
//    single-frame appearance; this recovered all four at confidence 1.00.
//
// AT OR ABOVE AUTO_ACCEPT (and with a decided side) it resolves; otherwise the
// item stays in the queue for /dev/source-review. The corpus measured 63/63
// both-sides-exact — but the threshold is a prudence margin for footage nobody
// has checked, not a filter for known errors, so the low-confidence path is the
// point rather than a formality.
//
// LOCAL ONLY, never in CI. It downloads one-second video windows, and
// datacenter IPs are routinely blocked (2XKO learned this the hard way and its
// daily Action never runs yt-dlp either). The cron queues; this resolves; the
// human arbitrates.
//
// Run: npm run data:extract -- [--limit N] [--ids a,b] [--dry] [--frames N]
//      then `npm run data:parse` to fold the verdicts into the substrate.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CACHE, grabFrames, pruneClips } from './hud-frames';
import {
  AUTO_ACCEPT,
  RESAMPLE_BELOW,
  RESAMPLE_FRAMES,
  SIDES,
  foldSide,
  loadRoster,
  makeHandleWorker,
  makeWorker,
  readFrame,
  resolveSide,
  samplePlan,
} from './hud-read';
import type { FrameRead, SideResult } from './hud-read';
import type { ReviewQueueItem, VideoOverride } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const onlyIds = flag('--ids')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const limit = Number(flag('--limit') ?? 0);
const nFrames = Number(flag('--frames') ?? 9);
const dry = argv.includes('--dry');

const read = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;

const queue = read<ReviewQueueItem[]>('data/review-queue.json').filter(
  (q) => q.kind === 'character-completion',
);
let work = onlyIds ? queue.filter((q) => onlyIds.includes(q.id)) : queue;
if (limit > 0) work = work.slice(0, limit);

if (!work.length) {
  console.log(
    `Nothing to do — ${queue.length} character-completion item(s) in the queue` +
      `${onlyIds ? ' (none matched --ids)' : ''}.`,
  );
  process.exit(0);
}

console.log(
  `${work.length} item(s) · ${nFrames} frames each · auto-accept ≥ ${AUTO_ACCEPT} ` +
    `· re-sample below ${RESAMPLE_BELOW}`,
);

const roster = await loadRoster();
const worker = await makeWorker();
const handleWorker = await makeHandleWorker();
const overrides = read<Record<string, VideoOverride>>('data/overrides.json');

let resolved = 0;
let deferred = 0;

/** Every cached frame for this id, in timestamp order. Reading the DIRECTORY
 *  rather than the paths just downloaded is what makes the re-sample additive:
 *  the second pass folds the original frames together with the new ones. */
const framesOf = (id: string): string[] => {
  const dir = join(CACHE, 'frames', id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => join(dir, f));
};

async function readAll(frames: string[]): Promise<Record<string, FrameRead[]>> {
  const reads: Record<string, FrameRead[]> = { p1: [], p2: [] };
  for (const f of frames) {
    for (const side of SIDES) reads[side]!.push(await readFrame(worker, f, side, roster));
  }
  return reads;
}

for (const [i, item] of work.entries()) {
  await grabFrames(item.id, samplePlan(item.durationSec, nFrames));
  let frames = framesOf(item.id);
  let reads = await readAll(frames);
  let p1 = foldSide(reads.p1!);
  let p2 = foldSide(reads.p2!);
  let resampled = false;

  // A thin read is not a verdict — pull more frames before judging it.
  if (Math.min(p1.confidence, p2.confidence) < RESAMPLE_BELOW) {
    await grabFrames(item.id, samplePlan(item.durationSec, RESAMPLE_FRAMES));
    frames = framesOf(item.id);
    reads = await readAll(frames);
    p1 = foldSide(reads.p1!);
    p2 = foldSide(reads.p2!);
    resampled = true;
  }

  // WHICH PLAYER IS ON WHICH SIDE — read, never assumed from the title.
  const handles = (item.handles ?? ['', '']) as [string, string];
  const side = await resolveSide(handleWorker, frames, handles);
  pruneClips(item.id);

  const confidence = Math.min(p1.confidence, p2.confidence);
  const ok =
    p1.characters.length > 0 &&
    p2.characters.length > 0 &&
    confidence >= AUTO_ACCEPT &&
    side.decided;

  const show = (s: SideResult) => `${s.characters.join('+') || '—'} ${s.confidence.toFixed(2)}`;
  console.log(
    `  [${i + 1}/${work.length}] ${item.id}  ${show(p1)}  vs  ${show(p2)}  ` +
      `side ${side.decided ? (side.leftIsFirst ? 'title-order' : 'REVERSED') : 'UNDECIDED'}` +
      `${resampled ? ' (re-sampled)' : ''} → ${ok ? 'RESOLVE' : 'review'}`,
  );

  if (!ok) {
    deferred++;
    continue;
  }
  resolved++;
  // The handles come from the QUEUE, not from the extractor: the title already
  // stated them, and parse.ts canonicalised them against players.json so a
  // verdict cannot mint a second page for an existing player. What the footage
  // decides is only WHICH of the two sits on which side.
  const leftHandle = side.leftIsFirst ? handles[0] : handles[1];
  const rightHandle = side.leftIsFirst ? handles[1] : handles[0];
  overrides[item.id] = {
    ...overrides[item.id],
    '//': `character-completion: read from footage [data:extract ${new Date().toISOString().slice(0, 10)}]`,
    sides: [
      { player: slug(leftHandle), handle: leftHandle.trim(), characters: p1.characters },
      { player: slug(rightHandle), handle: rightHandle.trim(), characters: p2.characters },
    ] as VideoOverride['sides'],
    resolvedBy: 'extractor',
    confidence,
    sideVotes: side.votes,
  } as VideoOverride;
}

await worker.terminate();
await handleWorker.terminate();

if (!dry && resolved > 0) {
  writeFileSync(join(DATA, 'overrides.json'), serialize(overrides), 'utf8');
}
console.log(
  `\n✔ ${resolved} resolved${dry ? ' (DRY — nothing written)' : ' → data/overrides.json'}, ` +
    `${deferred} left for /dev/source-review.` +
    (resolved && !dry ? ' Next: npm run data:parse' : ''),
);

/** parse.ts's identity rule, restated (pipeline modules never enter the Nuxt graph). */
function slug(handle: string): string {
  return handle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** data/overrides.json stores non-ASCII escaped; writing it literally would
 *  reformat every line containing one on every run. Same shape as the review
 *  POST route's serializer, so the two paths produce identical files. */
function serialize(value: unknown): string {
  return (
    JSON.stringify(value, null, 2).replace(
      /[\u0080-\uffff]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    ) + '\n'
  );
}
