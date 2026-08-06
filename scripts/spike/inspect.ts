// SPIKE: per-frame reads for one video/side, so a disputed verdict can be
// checked against the actual pixels instead of trusted. Prints the raw OCR
// strings from all four thresholds, which is what makes a wrong read
// diagnosable (a missing alias looks nothing like a bad crop).
//
// Run: tsx scripts/spike/inspect.ts <videoId> <p1|p2>

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CACHE } from '../hud-frames';
import { loadRoster, makeWorker, readFrame, type Side } from '../hud-read';

const [id, side] = process.argv.slice(2) as [string, Side];
if (!id || (side !== 'p1' && side !== 'p2')) {
  console.error('usage: tsx scripts/spike/inspect.ts <videoId> <p1|p2>');
  process.exit(64);
}

const dir = join(CACHE, 'frames', id);
if (!existsSync(dir)) {
  console.error(`no frames cached for ${id}`);
  process.exit(1);
}
const frames = readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort();

const roster = await loadRoster();
const worker = await makeWorker();

console.log(`${id} ${side} — ${frames.length} frames\n`);
for (const f of frames) {
  const r = await readFrame(worker, join(dir, f), side, roster);
  console.log(
    `  ${f.replace('.png', '')}  ${(r.id ?? '—').padEnd(11)} votes ${r.votes}/${r.of} dist ${r.dist === 99 ? '-' : r.dist}   raw: ${r.raw.map((x) => JSON.stringify(x)).join(' ')}`,
  );
}
await worker.terminate();
