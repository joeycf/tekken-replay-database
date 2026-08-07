// Read the two character nameplates off one Tekken 8 tournament frame.
//
// WHAT THE RECON FOUND (cache/evo/frames, Evo 2024 / Evo Japan 2025 / Evo 2026)
// — and it is NOT what SF6 found, so this is the one place the port could not
// be a copy:
//
//   SF6 prints the CHARACTER name in the top two corners and the player's
//   handle nowhere. Tekken 8's broadcast HUD is the other way round. The top
//   strip carries the PLAYER (with org tags: "TM | RB ARSLAN ASH", "DRX KNEE"),
//   and the CHARACTER name sits BELOW the health bar — left-aligned from x≈54
//   and right-aligned to x≈1222 at 720p, on a band around y≈79-98.
//
//   Porting SF6's REGIONS verbatim would therefore have read the player handle
//   on every frame: a value the title already states, that matches no roster
//   alias, and that would have produced a clean-looking 0% with no obvious
//   cause. This is the single highest-value finding of the recon.
//
// The layout is stable across Evo 2024, Evo Japan 2025 and Evo 2026 — three
// events, three overlay skins, three years — which is what makes a fixed crop
// viable at all, the same property SF6 relied on.
//
// LOCALIZATION: Evo Japan runs the same romanized nameplates (BRYAN, CLAUDIO),
// so Tekken has no equivalent of SF6's VEGA problem, where the Japanese-UI HUD
// renamed M. Bison and cost seven frames. Checked, not assumed. Alias room is
// kept anyway — data/characters.json already carries curated variants.
//
// WHY OCR AND NOT TEMPLATE MATCHING: templates need a labelled example per
// class, and 62 VODs do not cover 42 characters — the tail would be permanently
// unidentifiable, and so would any character Bandai Namco ships next. OCR reads
// a name it has never seen and hands it to the alias table that already exists
// in data/characters.json.
//
// WHY AN ENSEMBLE OF THRESHOLDS: the glyphs are near-white over a health bar
// and live gameplay, so the one threshold that separates them moves with the
// background. Read at several, match each, vote. Tesseract's own confidence is
// NOT usable as the signal (SF6 measured it returning 0 on a correct read and
// 95 on a wrong one); agreement and edit distance are.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';

import { buildAliasMatcher, loadCharacters } from './roster';
import { CACHE } from './hud-frames';

/** Nameplate crops as fractions of the frame, measured off the recon frames.
 *
 *  Both boxes stop short of the character PORTRAIT that bookends each side of
 *  the HUD (left ends x≈48, right starts x≈1232). Including it is SF6's Capcom
 *  hexagon lesson restated: a glyph-shaped blob at a fixed offset lands in
 *  every read as noise. */
export const REGIONS = {
  p1: [0.039, 0.104, 0.166, 0.038],
  p2: [0.79, 0.104, 0.17, 0.038],
} as const;

export type Side = keyof typeof REGIONS;
export const SIDES: Side[] = ['p1', 'p2'];

/** The two PLAYER plates in the HUD's top strip.
 *
 *  Deliberately wide: the plate's left edge moves with the org tag's length
 *  ("TM | RB ARSLAN ASH", "DRX KNEE", "NIP MEO-IL"), so a tight box would clip
 *  the handle on exactly the sponsored players whose names matter most. The
 *  surrounding noise — org tag, country code, round score — is harmless here
 *  because both candidate handles are scored against the same string; it only
 *  has to favour the right one. */
export const HANDLE_REGIONS = {
  p1: [0.1, 0.0, 0.3, 0.042],
  p2: [0.6, 0.0, 0.3, 0.042],
} as const;

const THRESHOLDS = [140, 170, 200, 225];
/** Fewer passes for the handle plates: they are flat UI chrome on a solid fill,
 *  not glyphs over animated splash art, so the ensemble that the character row
 *  needs is wasted work here. */
const HANDLE_THRESHOLDS = [0, 150, 190];
const UPSCALE = 4;

/** Crop one HUD region and tone it for OCR.
 *
 *  Two tonings, and the difference is measured rather than stylistic. The
 *  CHARACTER row is thresholded and negated — near-white glyphs over the
 *  character's own animated splash art, which tesseract reads best as black on
 *  white. The PLAYER plates are flat UI chrome on a solid fill and are read
 *  WITHOUT the negate, normalised instead of thresholded on the first pass.
 *  That combination is what the 61/61 side-resolution measurement was taken
 *  with; changing it changes a measured number, so it is a parameter rather
 *  than a cleanup. */
export async function prep(
  file: string,
  region: readonly number[],
  threshold: number,
  plate = false,
): Promise<Buffer> {
  const meta = await sharp(file).metadata();
  const W = meta.width ?? 1280;
  const H = meta.height ?? 720;
  const base = sharp(file)
    .extract({
      left: Math.round(region[0]! * W),
      top: Math.round(region[1]! * H),
      width: Math.round(region[2]! * W),
      height: Math.round(region[3]! * H),
    })
    .resize({ width: Math.round(region[2]! * W * UPSCALE), kernel: 'lanczos3' })
    .greyscale();
  const toned = threshold > 0 ? base.threshold(threshold) : base.normalise();
  return (plate ? toned : toned.negate()).png().toBuffer();
}

// ── fuzzy alias matching ─────────────────────────────────────────────────────
/** Optimal string alignment distance (Damerau without unrestricted transposes),
 *  the same measure the SF6 spike and 2XKO's parse.ts use. */
export function osa(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n]!;
}

export interface Alias {
  alias: string;
  id: string;
  /** Largest edit budget at which this alias is still uniquely decodable —
   *  floor((d(alias, nearest other character's alias) - 1) / 2). */
  radius: number;
}

export interface Roster {
  aliases: Alias[];
  exact: (text: string) => string | null;
  ids: Set<string>;
}

export async function loadRoster(): Promise<Roster> {
  const characters = await loadCharacters();
  const matcher = buildAliasMatcher(characters);
  const flat = characters.flatMap((c) =>
    (c.extra?.aliases ?? [c.name.toLowerCase()]).map((alias) => ({ alias, id: c.id })),
  );
  // Per-alias decoding radius, computed from the roster rather than assumed.
  const aliases: Alias[] = flat.map(({ alias, id }) => {
    let nearest = Infinity;
    for (const o of flat) {
      if (o.id === id) continue;
      const d = osa(alias, o.alias);
      if (d < nearest) nearest = d;
    }
    return { alias, id, radius: Math.max(0, Math.floor((nearest - 1) / 2)) };
  });
  return { aliases, exact: (t) => matcher.one(t), ids: new Set(characters.map((c) => c.id)) };
}

export interface Match {
  id: string;
  /** 0 = exact alias hit; higher = looser fuzzy hit */
  dist: number;
}

/** Resolve one OCR string to a roster id.
 *
 *  THE EDIT BUDGET IS ROSTER-DERIVED, NOT PURELY LENGTH-SCALED — this is the
 *  one inherited rule the Tekken roster forced a rewrite of.
 *
 *  SF6's rule was "exact match for names ≤2 letters" (its `ed` phantoms), inside
 *  a length-scaled budget. On Tekken that rule is DEAD CODE: the shortest alias
 *  here is 3 characters, so it can never fire. And the length scaling alone is
 *  unsafe on 59 of the 83 aliases, because Tekken's collisions do not correlate
 *  with length the way SF6's did. Measured minimum cross-character distances:
 *
 *    len 3   jin/jun, lee/leo            distance 1   ← budget would be 1
 *    len 4   anna/nina, feng/king        distance 2   ← budget would be 2
 *    len 10  "jin kazama"/"jun kazama"   distance 1   ← budget would be THREE
 *
 *  The worst case is not the short names at all: it is the full-name aliases,
 *  where SF6's length scaling is most generous and the true separation is
 *  smallest. A 3-error artefact could flip Jin to Jun.
 *
 *  So each alias also carries its own unique-decoding radius,
 *  floor((d_nearest - 1) / 2), and the effective budget is the MINIMUM of the
 *  two. Length scaling still guards the noise-magnet problem SF6 found; the
 *  radius guards collisions. 21 of 83 aliases end up exact-match-only, which
 *  includes every distance-1 pair above. */
export function matchRead(raw: string, roster: Roster): Match | null {
  const text = raw
    .toLowerCase()
    .replace(/[^a-z0-9. -]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 2) return null;

  const hit = roster.exact(text);
  if (hit) return { id: hit, dist: 0 };

  const lengthBudget = text.length <= 3 ? 0 : text.length <= 6 ? 1 : text.length <= 9 ? 2 : 3;
  let best: Match | null = null;
  let runnerUp = Infinity;
  for (const { alias, id, radius } of roster.aliases) {
    const d = osa(text, alias);
    if (d > Math.min(lengthBudget, radius)) continue;
    if (d < (best?.dist ?? Infinity)) {
      if (best && best.id !== id) runnerUp = best.dist;
      best = { id, dist: d };
    } else if (d < runnerUp && best && id !== best.id) {
      runnerUp = d;
    }
  }
  if (!best) return null;
  // an ambiguous read (two roster names equally close) is worse than no read
  if (runnerUp === best.dist) return null;
  return best;
}

// ── per-frame read ───────────────────────────────────────────────────────────
export interface FrameRead {
  frame: string;
  side: Side;
  /** winning id across the threshold ensemble, or null when nothing matched */
  id: string | null;
  votes: number;
  of: number;
  dist: number;
  /** raw OCR strings, kept for the failure report */
  raw: string[];
}

export async function readFrame(
  worker: Worker,
  file: string,
  side: Side,
  roster: Roster,
  region: readonly number[] = REGIONS[side],
): Promise<FrameRead> {
  const raw: string[] = [];
  const tally = new Map<string, { votes: number; dist: number }>();
  for (const th of THRESHOLDS) {
    const png = await prep(file, region, th);
    const { data } = await worker.recognize(png);
    const text = data.text.replace(/\s+/g, ' ').trim();
    raw.push(text);
    const m = matchRead(text, roster);
    if (!m) continue;
    const cur = tally.get(m.id);
    if (cur) {
      cur.votes++;
      cur.dist = Math.min(cur.dist, m.dist);
    } else {
      tally.set(m.id, { votes: 1, dist: m.dist });
    }
  }
  let id: string | null = null;
  let votes = 0;
  let dist = 99;
  for (const [k, v] of tally) {
    if (v.votes > votes || (v.votes === votes && v.dist < dist)) {
      id = k;
      votes = v.votes;
      dist = v.dist;
    }
  }
  return { frame: file, side, id, votes, of: THRESHOLDS.length, dist, raw };
}

// ── per-video fold ───────────────────────────────────────────────────────────
export interface Member {
  char: string;
  /** frames that read it */
  frames: number;
  /** longest run of CONSECUTIVE reading frames that read it */
  run: number;
  /** index of the first frame that read it — the ordering key */
  firstAt: number;
  /** mean edit distance of those reads (0 = exact alias hits) */
  dist: number;
  confidence: number;
}

export interface SideResult {
  /** every character this side played, first-appearance order. The record holds
   *  what the footage holds: a set VOD is several games and a player may
   *  counter-pick between them. A 1v1 match is simply the length-1 case. */
  characters: string[];
  confidence: number;
  members: Member[];
  /** reads rejected as too thin to be evidence, kept so they stay visible */
  dropped: { char: string; frames: number }[];
  /** frames that produced a usable read */
  read: number;
  /** frames sampled */
  sampled: number;
  /** something was dropped — the side is not trusted even if what remains is */
  shaky: boolean;
}

/** A member needs a run of at least this many CONSECUTIVE reading frames. */
const MIN_RUN = 2;

/** Sides at or above this auto-resolve; below it a human confirms.
 *
 *  Measured over all 63 hand-labelled Tekken Evo VODs (2026-08-07), where the
 *  extractor scored 63/63 both-sides-exact and 126/126 per-side. Precision is
 *  therefore 100% at EVERY threshold and this number cannot be tuned against
 *  observed mistakes — it is a prudence margin for footage nobody has checked,
 *  not a filter for known errors. It costs 4 of 63 videos (6.3%) in review.
 *
 *  0.90 deliberately matches SF6's, so the two pipelines stay comparable rather
 *  than each carrying a differently-derived number that means the same thing.
 *
 *  What a threshold CANNOT do: rescue a confidently-wrong read. Before the
 *  labels were corrected, the corpus's two worst records both sat at confidence
 *  1.00 — one a missed counter-pick, one a swapped attribution. Both were fixed
 *  at the reader (dense re-sampling) and at the attribution (resolveSide), not
 *  at this gate. */
export const AUTO_ACCEPT = 0.9;

/** Below this, re-sample the video densely and fold again before judging it.
 *
 *  A character that occupies a single sampled frame is dropped by MIN_RUN, and
 *  nine samples is too few to tell a real brief appearance from noise. Four
 *  corpus videos failed exactly that way; re-sampling them at 21 frames
 *  recovered every one and moved all four to confidence 1.00, taking the corpus
 *  from 58/63 to 62/63.
 *
 *  The rule is LABEL-BLIND, which is what makes it a policy rather than a fit:
 *  the four videos it fires on are precisely the four with any side below 0.60,
 *  selected without reference to any label. */
export const RESAMPLE_BELOW = 0.6;
export const RESAMPLE_FRAMES = 21;

/** Fold one side's frame reads (in timestamp order) into an ordered union.
 *
 *  CONTIGUITY, NOT SHARE — inherited from SF6 unchanged, because the reasoning
 *  is about tournament sets rather than about SF6. The obvious agreement metric,
 *  a character's share of the frames that read anything, is actively wrong for a
 *  union: on a set where a player switched after game one, the correct first
 *  character may hold only 2 of 7 reading frames and would score 0.29. What
 *  separates a real game segment from a misread is that the segment is
 *  CONSECUTIVE — real play occupies a contiguous stretch, noise is isolated.
 *
 *    member_c = min(1, run_c / MIN_RUN) × (1 - meanDist_c / 3)
 *    coverage = min(1, read / 4)      ← a side legible in 2 of 9 frames is a
 *                                       guess however unanimous those 2 were
 *    side     = min over members × coverage
 *
 *  `min` over members, not mean: a union is only as trustworthy as its weakest
 *  character. */
export function foldSide(reads: FrameRead[]): SideResult {
  const sampled = reads.length;
  const usable = reads.filter((r) => r.id);

  const tally = new Map<string, { frames: number; dist: number[]; firstAt: number; run: number }>();
  let prev: string | null = null;
  let runLen = 0;
  for (const [i, r] of reads.entries()) {
    // A blank frame is NEUTRAL — absence of evidence, not evidence of absence —
    // so it must not break a run. Tournament VODs cut to crowd shots, replays
    // and player cams constantly, and those frames read nothing; the recon
    // measured 20% of sampled frames reading nothing for exactly this reason
    // (one Evo 2026 sample was a full-frame audience shot). Counting them as
    // breaks would split one real segment into two rejected fragments — SF6 lost
    // a real character to precisely this before fixing it. Runs are therefore
    // measured over the subsequence of frames that read SOMETHING.
    if (!r.id) continue;
    runLen = r.id === prev ? runLen + 1 : 1;
    prev = r.id;
    const t = tally.get(r.id) ?? { frames: 0, dist: [], firstAt: i, run: 0 };
    t.frames++;
    t.dist.push(r.dist);
    t.run = Math.max(t.run, runLen);
    tally.set(r.id, t);
  }

  const coverage = Math.min(1, usable.length / 4);
  const all = [...tally.entries()]
    .map(([char, t]) => {
      const dist = t.dist.reduce((a, b) => a + b, 0) / t.dist.length;
      return {
        char,
        frames: t.frames,
        run: t.run,
        firstAt: t.firstAt,
        dist: Number(dist.toFixed(2)),
        confidence: Number((Math.min(1, t.run / MIN_RUN) * Math.max(0, 1 - dist / 3)).toFixed(3)),
      };
    })
    .sort((a, b) => a.firstAt - b.firstAt);

  const members = all.filter((m) => m.run >= MIN_RUN);
  const dropped = all
    .filter((m) => m.run < MIN_RUN)
    .map((m) => ({ char: m.char, frames: m.frames }));

  const confidence = members.length
    ? Number((Math.min(...members.map((m) => m.confidence)) * coverage).toFixed(3))
    : 0;

  return {
    characters: members.map((m) => m.char),
    confidence: dropped.length ? Number((confidence / 2).toFixed(3)) : confidence,
    members,
    dropped,
    read: usable.length,
    sampled,
    shaky: dropped.length > 0,
  };
}

// ── which player is on which side ────────────────────────────────────────────
/** Score how well `text` contains `handle`; 0 is a clean hit, 99 is nothing.
 *
 *  Scored over the best WINDOW of the read rather than the whole string,
 *  because the plate carries an org tag and a country code around the handle
 *  and a whole-string distance would drown the signal in them. */
export function scoreHandle(text: string, handle: string): number {
  const t = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const h = handle.toLowerCase().replace(/[^a-z0-9]+/g, '');
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

export interface SideResolution {
  /** true when candidates[0] is the player on the LEFT of the screen */
  leftIsFirst: boolean;
  /** signed vote margin across frames; 0 means the footage could not say */
  votes: number;
  decided: boolean;
}

/** Decide which of two known players occupies the LEFT of the screen.
 *
 *  WHY THIS EXISTS. `foldSide` reads characters by SCREEN position, and the
 *  corpus supplies handles in TITLE order. Pairing them assumes the title names
 *  the left player first — measured over the labelled Evo corpus, that is wrong
 *  on 23 of 61 videos (37.7%). "Evo 2026: Arslan Ash vs Rangchu" has Rangchu on
 *  the left. Pairing positionally therefore produces records where every
 *  character is correct and every player is wrong, and no confidence signal can
 *  catch it because the character reads are perfect.
 *
 *  The handle is on screen too, and the job is far easier than reading a
 *  character: both candidates are already known from the title, so this is a
 *  TWO-WAY CHOICE rather than open-vocabulary recognition. Read each plate,
 *  score both candidates against it, and let every frame vote. Measured 61/61
 *  on the labelled corpus, 0 undecided.
 *
 *  Returns decided=false rather than guessing when the frames disagree or say
 *  nothing; the caller must treat that as "not resolvable", never as a default. */
export async function resolveSide(
  worker: Worker,
  frames: string[],
  candidates: [string, string],
): Promise<SideResolution> {
  let votes = 0;
  for (const f of frames) {
    let first = 0; // total distance if candidates[0] is on the LEFT
    let second = 0; // total distance if candidates[1] is on the LEFT
    let read = false;
    for (const th of HANDLE_THRESHOLDS) {
      for (const side of SIDES) {
        const png = await prep(f, HANDLE_REGIONS[side], th, true);
        const { data } = await worker.recognize(png);
        const text = data.text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const self = side === 'p1' ? 0 : 1;
        const other = side === 'p1' ? 1 : 0;
        const dSelf = scoreHandle(text, candidates[self]!);
        const dOther = scoreHandle(text, candidates[other]!);
        // a plate that matches neither candidate is chrome, not evidence
        if (Math.min(dSelf, dOther) > 3) continue;
        read = true;
        first += dSelf;
        second += dOther;
      }
    }
    if (!read || first === second) continue;
    votes += first < second ? 1 : -1;
  }
  return { leftIsFirst: votes > 0, votes, decided: votes !== 0 };
}

export async function makeWorker(): Promise<Worker> {
  // logger/errorHandler silence tesseract.js's progress chatter; debug_file
  // silences the engine's per-call statistics dump, which it prints for every
  // blank crop — i.e. for every non-gameplay frame, a large share of a
  // tournament VOD. cachePath keeps eng.traineddata inside the gitignored spike
  // cache instead of the process cwd (the repo root, where it lands as a stray
  // untracked file).
  const worker = await createWorker('eng', undefined, {
    logger: () => {},
    errorHandler: () => {},
    cachePath: CACHE,
  });
  await worker.setParameters({
    // "8" is whitelisted for Jack-8: SF6's whitelist was letters-only, and both
    // "jack-8" and "jack 8" would arrive stripped to "jack". That still
    // resolves, because a bare "jack" alias happens to exist — but only by
    // luck, and the next numbered character would have no such fallback.
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ8.- ',
    tessedit_pageseg_mode: '7' as never, // single text line
    debug_file: '/dev/null',
  });
  return worker;
}

/** A SECOND worker, with NO character whitelist, for the player plates.
 *
 *  It cannot share the character worker: that one is whitelisted to letters
 *  plus "8", which is right for a 42-name roster and wrong for handles.
 *  "Shadow 20z", "Ninjakilla_212" and "Meo-IL" would all arrive mangled, and
 *  the side resolution scores candidates against exactly those strings. The
 *  61/61 measurement was taken with an unwhitelisted worker, so this keeps the
 *  measured configuration rather than economising on a process. */
export async function makeHandleWorker(): Promise<Worker> {
  const worker = await createWorker('eng', undefined, {
    logger: () => {},
    errorHandler: () => {},
    cachePath: CACHE,
  });
  await worker.setParameters({
    tessedit_pageseg_mode: '7' as never, // single text line
    debug_file: '/dev/null',
  });
  return worker;
}

/** Sampling plan for a match VOD. Deliberately not a flat 20/40/60/80%: a
 *  bracket set is several games plus walk-ons, replays and crowd cuts, so
 *  spread wider and take more — non-gameplay frames read as nothing and cost
 *  only their share of the vote. */
export function samplePlan(durationSec: number, n = 9): number[] {
  const lo = 0.08;
  const hi = 0.94;
  return Array.from({ length: n }, (_, i) =>
    Math.round(durationSec * (lo + ((hi - lo) * i) / (n - 1))),
  );
}

export const readJson = async <T>(p: string): Promise<T> =>
  JSON.parse(await readFile(p, 'utf8')) as T;
export { join };
