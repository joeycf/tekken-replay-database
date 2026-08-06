// SPIKE A4: run the nameplate reader over match-shaped Evo VODs.
//
// Pipeline per video: sample timestamps → yt-dlp one-second windows → ffmpeg
// one PNG each → OCR both nameplate crops at four thresholds → fuzzy-match to
// the roster → vote within the frame, then fold across frames.
//
// Incremental and resumable, like 2XKO's fuses.ts: results flush after EVERY
// video and ids already present are skipped unless --force. Frames stay cached
// under cache/evo/frames/<id>/, so a re-run costs no downloads at all — which
// is the whole point of --force: re-folding the corpus after a reader change
// takes seconds instead of hours.
//
// Run: tsx scripts/spike/extract-chars.ts [--ids a,b] [--limit N] [--frames N]
//                                         [--force] [--keep-clips]

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE, grabFrames, pruneClips } from '../hud-frames';
import {
  SIDES,
  foldSide,
  loadRoster,
  makeWorker,
  readFrame,
  readJson,
  samplePlan,
  type FrameRead,
  type SideResult,
} from '../hud-read';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string) => argv.includes(name);

const onlyIds = flag('--ids')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const limit = Number(flag('--limit') ?? 0);
const nFrames = Number(flag('--frames') ?? 9);
const force = has('--force');
const keepClips = has('--keep-clips');

interface CorpusItem {
  id: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  event: string;
  round: string | null;
  handles: [string, string];
}

export interface Extraction {
  id: string;
  event: string;
  handles: [string, string];
  p1: SideResult;
  p2: SideResult;
  /** wall-clock seconds and bytes this video cost */
  cost: { sec: number; bytes: number };
  frames: string[];
  /** Per-frame reads in timestamp order, so a fold never needs to re-OCR.
   *  Persisted from day one on SF6's evidence: its first pass stored only
   *  aggregate counts, so changing the fold — or fixing one alias — cost a full
   *  re-read of every frame in the corpus. */
  reads: { f: string; p1: [string | null, number]; p2: [string | null, number] }[];
}

const corpus = await readJson<CorpusItem[]>(join(CACHE, 'corpus.json'));
const outPath = join(CACHE, 'extracted.json');
// ALWAYS load the existing results, --force included. `force` means "redo the
// ids in scope", never "forget everything else": the file is rewritten whole
// from this map after every video, so loading it conditionally made
// `--force --ids a,b` silently truncate extracted.json to two entries and
// discard the other 61 — two hours of downloads, gone, with a ✔ on stdout.
// (Inherited from SF6's spike, where --force is only ever used bare and the
// bug therefore cannot fire.)
const done = new Map<string, Extraction>();
if (existsSync(outPath)) {
  for (const e of await readJson<Extraction[]>(outPath)) done.set(e.id, e);
}

let work = corpus;
if (onlyIds) work = work.filter((c) => onlyIds.includes(c.id));
if (!force) work = work.filter((c) => !done.has(c.id));
if (limit > 0) work = work.slice(0, limit);

console.log(
  `corpus ${corpus.length} · already done ${done.size} · this run ${work.length} · ${nFrames} frames/video`,
);

const roster = await loadRoster();
const worker = await makeWorker();

const dirBytes = (d: string): number => {
  if (!existsSync(d)) return 0;
  return readdirSync(d, { withFileTypes: true }).reduce((sum, f) => {
    const p = join(d, f.name);
    if (f.isDirectory()) return sum + dirBytes(p);
    try {
      return sum + statSync(p).size;
    } catch {
      return sum;
    }
  }, 0);
};

mkdirSync(CACHE, { recursive: true });

for (const [i, v] of work.entries()) {
  const t0 = Date.now();
  const plan = samplePlan(v.durationSec, nFrames);
  await grabFrames(v.id, plan);

  const dir = join(CACHE, 'frames', v.id);
  const frames = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.png'))
        .sort()
        .map((f) => join(dir, f))
    : [];

  const bytes = dirBytes(join(CACHE, 'clips', v.id)) + dirBytes(dir);

  const reads: Record<string, FrameRead[]> = { p1: [], p2: [] };
  for (const f of frames) {
    for (const side of SIDES) reads[side]!.push(await readFrame(worker, f, side, roster));
  }

  const stems = frames.map((f) => f.split('/').pop()!.replace('.png', ''));
  const rec: Extraction = {
    id: v.id,
    event: v.event,
    handles: v.handles,
    p1: foldSide(reads.p1!),
    p2: foldSide(reads.p2!),
    cost: { sec: Number(((Date.now() - t0) / 1000).toFixed(1)), bytes },
    frames: frames.map((f) => f.split('/').pop()!),
    reads: stems.map((f, n) => ({
      f,
      p1: [reads.p1![n]!.id, reads.p1![n]!.dist === 99 ? -1 : reads.p1![n]!.dist],
      p2: [reads.p2![n]!.id, reads.p2![n]!.dist === 99 ? -1 : reads.p2![n]!.dist],
    })),
  };
  if (!keepClips) pruneClips(v.id);
  done.set(v.id, rec);
  writeFileSync(outPath, JSON.stringify([...done.values()], null, 1) + '\n', 'utf8');

  const fmt = (s: SideResult) =>
    `${(s.characters.join('+') || '—').padEnd(18)} ${s.confidence.toFixed(2)} (${s.read}/${s.sampled})` +
    `${s.dropped.length ? ` dropped:${s.dropped.map((d) => d.char).join(',')}` : ''}`;
  console.log(
    `  [${String(i + 1).padStart(3)}/${work.length}] ${v.id}  ${v.handles[0]} vs ${v.handles[1]}\n` +
      `        p1 ${fmt(rec.p1)}\n        p2 ${fmt(rec.p2)}   ${rec.cost.sec}s ${(rec.cost.bytes / 1e6).toFixed(1)}MB`,
  );
}

await worker.terminate();
console.log(`\n✔ ${outPath} (${done.size} videos)`);
