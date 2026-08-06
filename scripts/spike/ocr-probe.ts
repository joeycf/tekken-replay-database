// SPIKE A3: does the crop actually read? Grid-search it rather than assert it.
//
// The recon established WHERE the character name lives by eye (below the health
// bar, not in the top corners — see scripts/hud-read.ts's header). A crop config
// derived by eye is still a guess, and baking a wrong one into a 62-video
// corpus run costs two hours of downloads to discover. So sweep a small grid of
// candidate boxes over every recon frame and report which reads most.
//
// The score is deliberately NOT accuracy — there are no labels yet. It is
// READ RATE: what fraction of frames produced any roster match at all. A crop
// that reads nothing is wrong; a crop that reads a lot is worth labelling
// against later. Ground truth arrives in §4.
//
// Run: tsx scripts/spike/ocr-probe.ts [--variants]

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE } from '../hud-frames';
import { SIDES, loadRoster, makeWorker, readFrame, type Side } from '../hud-read';

const showVariants = process.argv.includes('--variants');

// Candidate boxes [left, top, width, height] as frame fractions. The centre
// entry is the measured one; the others widen/shift it so the sweep says
// whether the measurement sits on a plateau or on a knife edge.
const VARIANTS: Record<string, { p1: number[]; p2: number[] }> = {
  measured: { p1: [0.039, 0.104, 0.166, 0.038], p2: [0.79, 0.104, 0.17, 0.038] },
  taller: { p1: [0.039, 0.098, 0.166, 0.05], p2: [0.79, 0.098, 0.17, 0.05] },
  wider: { p1: [0.035, 0.104, 0.2, 0.038], p2: [0.76, 0.104, 0.204, 0.038] },
  higher: { p1: [0.039, 0.094, 0.166, 0.038], p2: [0.79, 0.094, 0.17, 0.038] },
  lower: { p1: [0.039, 0.114, 0.166, 0.038], p2: [0.79, 0.114, 0.17, 0.038] },
  'sf6-verbatim': { p1: [0.0016, 0.0167, 0.1, 0.0361], p2: [0.8984, 0.0167, 0.1, 0.0361] },
};

const framesRoot = join(CACHE, 'frames');
if (!existsSync(framesRoot)) {
  console.error('✖ No frames cached — run scripts/spike/recon.ts first.');
  process.exit(1);
}
const videos = readdirSync(framesRoot);
const frames = videos.flatMap((id) =>
  readdirSync(join(framesRoot, id))
    .filter((f) => f.endsWith('.png'))
    .map((f) => ({ id, path: join(framesRoot, id, f), name: f })),
);

console.log(`${frames.length} cached frames across ${videos.length} videos\n`);

const roster = await loadRoster();
const worker = await makeWorker();

const names = showVariants ? Object.keys(VARIANTS) : ['measured', 'sf6-verbatim'];

for (const name of names) {
  const v = VARIANTS[name]!;
  let read = 0;
  let total = 0;
  const perVideo = new Map<string, { read: number; total: number; ids: Set<string> }>();

  for (const f of frames) {
    for (const side of SIDES) {
      const r = await readFrame(worker, f.path, side as Side, roster, v[side as 'p1' | 'p2']);
      total++;
      const pv = perVideo.get(f.id) ?? { read: 0, total: 0, ids: new Set<string>() };
      pv.total++;
      if (r.id) {
        read++;
        pv.read++;
        pv.ids.add(r.id);
      }
      perVideo.set(f.id, pv);
    }
  }

  console.log(`── ${name} ${'─'.repeat(Math.max(0, 40 - name.length))}`);
  console.log(`   read rate ${read}/${total} (${((100 * read) / total).toFixed(1)}%)`);
  for (const [id, pv] of perVideo) {
    console.log(
      `     ${id}  ${String(pv.read).padStart(2)}/${pv.total}  → ${[...pv.ids].join(', ') || '—'}`,
    );
  }
  console.log();
}

await worker.terminate();
