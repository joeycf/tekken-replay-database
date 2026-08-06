// SPIKE A2: frame recon — the gate that picks the reader.
//
// Do NOT assume SF6's layout transfers. SF6 prints the CHARACTER name in the
// top two corners in tournament mode, which is what made a fixed crop viable
// there. Tekken 8's broadcast HUD is a different game's UI wearing a different
// event overlay, and the in-match nameplate may well carry the PLAYER handle
// (which the title already gives us and which would be worthless here). So
// before any harness gets written, pull real frames and LOOK at them.
//
// Three VODs from three different events across three years on purpose: Evo
// re-skins its overlay between events, and one of the three is an Evo JAPAN
// event because a Japanese-UI build is where localized nameplates would show up
// (SF6 lost seven frames on exactly this — M. Bison's plate reads VEGA on the
// Japanese HUD, and nine of its reads returned nothing until an alias was
// added). Tekken 8's cast is mostly romanized identically, but "mostly" is not
// a finding.
//
// Run: tsx scripts/spike/recon.ts

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CACHE, grabFrames, stamp } from '../hud-frames';

interface CorpusItem {
  id: string;
  title: string;
  durationSec: number;
  event: string;
  handles: [string, string];
}

const corpus = JSON.parse(await readFile(join(CACHE, 'corpus.json'), 'utf8')) as CorpusItem[];

// One late-bracket match from each of three events, chosen for overlay spread:
// the oldest mainline in the corpus, an Evo JAPAN event (localization check),
// and the newest mainline (what a future upload will actually look like).
const PICKS = [
  'Let0_1UY6fQ', // Evo 2024        — Arslan Ash vs Atif, Winners Finals
  'QGRjiOfPCtQ', // Evo Japan 2025  — Mulgold vs Knee
  'FsbLumb6iuU', // Evo 2026        — Arslan Ash vs Rangchu, Grand Final
];

// Spread wide, and deliberately include the first seconds: if character
// identity is only stated on a versus/loading screen, it lives near a game
// boundary, not at 20/40/60/80% of the runtime.
const FRACTIONS = [0.01, 0.04, 0.1, 0.2, 0.32, 0.45, 0.58, 0.7, 0.82, 0.93];

for (const id of PICKS) {
  const v = corpus.find((c) => c.id === id);
  if (!v) {
    console.error(`✖ ${id} not in corpus.json`);
    continue;
  }
  const secs = FRACTIONS.map((f) => Math.round(v.durationSec * f));
  console.log(`\n── ${v.event}: ${v.handles[0]} vs ${v.handles[1]} (${id}, ${v.durationSec}s)`);
  console.log(`   sampling ${secs.join(', ')}`);
  const t0 = Date.now();
  const got = await grabFrames(id, secs);
  console.log(
    `   ✔ ${got.length}/${secs.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  const missing = secs.filter((s) => !got.some((p) => p.endsWith(`${stamp(s)}.png`)));
  if (missing.length) console.log(`   ✖ missing: ${missing.join(', ')}`);
}

console.log(`\nFrames under ${join(CACHE, 'frames')}/<id>/`);
