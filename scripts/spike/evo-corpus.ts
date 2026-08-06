// SPIKE A1: isolate the match-shaped TEKKEN 8 corpus on @EvoEvents.
//
// Scratchpad only — writes nothing into data/. The enumeration lands in the
// gitignored cache/evo/ so the ~110 quota units are spent once and every later
// spike step reads the cache.
//
// @EvoEvents is the channel scripts/channels.ts evaluated and deliberately did
// NOT track: its titles name players, game and round but never characters
// ("Evo 2026: Arslan Ash vs Rangchu | TEKKEN 8 | Grand Final"), and emit.ts
// hard-fails a side without one.
//
// TWO THINGS DIFFER FROM THE SF6 PORT, both load-bearing:
//
// 1. Tekken's parse.ts has NO game-marker predicate. It never needed one — all
//    four tracked channels are Tekken-only, so the pipeline's gates are purely
//    structural (live / shorts / duration / pre-launch / title shape). Evo
//    uploads every game at the event, so a marker has to be introduced here.
//
// 2. That marker must say TEKKEN 8, not TEKKEN. Evo 2023's Tekken is TEKKEN 7 —
//    Tekken 8 launched 2024-01-26 — and a T7 VOD read against the T8 roster is
//    silent garbage: most of the T7 cast is still on the T8 roster, so a wrong
//    read looks entirely plausible. The pre-launch date gate catches T7 uploaded
//    in its own era, but NOT a T7 match re-uploaded after launch, so the marker
//    and the date gate are both required and neither is redundant. This script
//    reports what each one catches independently.
//
// Run: tsx --env-file-if-exists=.env scripts/spike/evo-corpus.ts [--refresh]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SeasonBoundary } from '../../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(ROOT, 'cache', 'evo');
const API_BASE = 'https://www.googleapis.com/youtube/v3';

// @EvoEvents — the id and pinned uploads playlist (UU + channelId.slice(2)),
// same convention as scripts/channels.ts. Same channel SF6 reads.
const CHANNEL_ID = 'UCWI626ZNdqM5tOlctPUTW2g';
const UPLOADS = 'UUWI626ZNdqM5tOlctPUTW2g';

const refresh = process.argv.includes('--refresh');

// Tekken 8's launch, read from the PERSISTED boundary table rather than
// restated — data/seasonBoundaries.json is written by parse.ts, so this cannot
// drift from the pipeline's own pre-launch gate (parse.ts:311).
const seasons = JSON.parse(
  await readFile(join(ROOT, 'data', 'seasonBoundaries.json'), 'utf8'),
) as SeasonBoundary[];
const LAUNCH = seasons.find((s) => s.season === 1)!.start;

// The game markers. T8_RE is the gate; T7_RE exists only to MEASURE what the
// gate excludes, so the T7 exclusion is evidenced rather than asserted.
//
// THE VERSION TOKEN IS SPELLED OUT ON PURPOSE — no bare \bT8\b. On this channel
// "T8" overwhelmingly means TOP 8, not Tekken 8: 26 titles carry a bare T8 and
// 23 of them are "ST 3v3 EVO 2014: T8 Quarters" (Super Turbo, Top-8 bracket) or
// multi-game stream VODs ("Evo 2026 Day 3: 2XKO, T8 & SF6 Top 8's"). Measured
// against the full enumeration, the bare token admits ZERO corpus members that
// the spelled form does not already match — it is all false positive and no
// signal. The pre-launch date gate happens to catch the 2014 batch today, which
// is exactly why this was worth checking rather than trusting: one post-2024
// "T8 Quarters" upload would put Super Turbo footage into a Tekken corpus.
//
// Same reasoning applies symmetrically to T7 (a bare token is ambiguous in both
// directions), so both sides use the spelled form only.
const T8_RE = /\bTEKKEN\s*8\b|鉄拳\s*8/i;
const T7_RE = /\bTEKKEN\s*7\b|鉄拳\s*7/i;
const ANY_TEKKEN_RE = /\bTEKKEN\b|鉄拳/i;

interface EvoRecord {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec: number;
  viewCount?: number;
  liveBroadcastContent: string;
  tags?: string[];
}

// ── API plumbing (same shape as scripts/fetch.ts; copied, not imported — that
// file is a top-level-await script that would run its whole fetch on import) ──
const rawKey = process.env.YT_API_KEY;
if (!rawKey) {
  console.error('✖ Missing YT_API_KEY (see .env.example).');
  process.exit(1);
}
const API_KEY: string = rawKey;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>,
  retries = 5,
): Promise<T> {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', API_KEY);

  for (let attempt = 1; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const body = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
      continue;
    }
    throw new Error(`YouTube API HTTP ${res.status} on ${endpoint}\n${body}`);
  }
  throw new Error('unreachable');
}

function parseDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

interface PlaylistItemsResponse {
  items: { contentDetails: { videoId: string } }[];
  nextPageToken?: string;
}
interface VideosResponse {
  items: {
    id: string;
    snippet: {
      title: string;
      description: string;
      publishedAt: string;
      liveBroadcastContent: string;
      tags?: string[];
    };
    contentDetails: { duration?: string };
    statistics?: { viewCount?: string };
  }[];
}

async function enumerate(): Promise<EvoRecord[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page: PlaylistItemsResponse = await apiGet('playlistItems', {
      part: 'contentDetails',
      playlistId: UPLOADS,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items) ids.push(it.contentDetails.videoId);
    pageToken = page.nextPageToken;
    if (ids.length % 500 === 0) console.log(`  …enumerated ${ids.length}`);
  } while (pageToken);

  const records: EvoRecord[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const res: VideosResponse = await apiGet('videos', {
      part: 'snippet,contentDetails,statistics',
      id: ids.slice(i, i + 50).join(','),
      maxResults: '50',
    });
    for (const v of res.items) {
      records.push({
        id: v.id,
        title: v.snippet.title,
        description: v.snippet.description,
        publishedAt: v.snippet.publishedAt,
        durationSec: parseDuration(v.contentDetails.duration),
        ...(v.statistics?.viewCount ? { viewCount: Number(v.statistics.viewCount) } : {}),
        liveBroadcastContent: v.snippet.liveBroadcastContent,
        ...(v.snippet.tags ? { tags: v.snippet.tags } : {}),
      });
    }
    if ((i / 50) % 20 === 19) console.log(`  …hydrated ${records.length}/${ids.length}`);
  }
  records.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return records;
}

// ── main ─────────────────────────────────────────────────────────────────────
await mkdir(CACHE, { recursive: true });
const cachePath = join(CACHE, 'enumeration.json');

let all: EvoRecord[];
if (!refresh) {
  try {
    all = JSON.parse(await readFile(cachePath, 'utf8')) as EvoRecord[];
    console.log(`Using cached enumeration (${all.length} uploads) — --refresh to re-fetch.`);
  } catch {
    console.log(`Enumerating @EvoEvents (${CHANNEL_ID})…`);
    all = await enumerate();
    await writeFile(cachePath, JSON.stringify(all, null, 1) + '\n', 'utf8');
  }
} else {
  console.log(`Enumerating @EvoEvents (${CHANNEL_ID})…`);
  all = await enumerate();
  await writeFile(cachePath, JSON.stringify(all, null, 1) + '\n', 'utf8');
}

const marked = (r: EvoRecord, re: RegExp) => re.test(r.title) || re.test(r.description);
const fmt = (s: number) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;

// ── T7 / T8 separation, measured before any gating ───────────────────────────
// The point of this block: prove the two mechanisms (marker, date) are each
// doing work, rather than assuming one subsumes the other.
const anyTekken = all.filter((r) => marked(r, ANY_TEKKEN_RE));
const t8 = anyTekken.filter((r) => marked(r, T8_RE));
const t7 = anyTekken.filter((r) => marked(r, T7_RE) && !marked(r, T8_RE));
const neither = anyTekken.filter((r) => !marked(r, T8_RE) && !marked(r, T7_RE));

console.log('\n── Tekken marker separation (whole channel) ───────────');
console.log(`  any Tekken signal            ${anyTekken.length}`);
console.log(`  TEKKEN 8 marked              ${t8.length}`);
console.log(`  TEKKEN 7 marked (not T8)     ${t7.length}`);
console.log(`  Tekken, version unstated     ${neither.length}`);

console.log('\n── T7 exclusion evidence ──────────────────────────────');
const t7PostLaunch = t7.filter((r) => r.publishedAt.slice(0, 10) >= LAUNCH);
console.log(`  T8 launch (seasonBoundaries.json S1.start)  ${LAUNCH}`);
console.log(`  T7-marked uploads                          ${t7.length}`);
console.log(`  …of those, published ON/AFTER launch        ${t7PostLaunch.length}`);
console.log(
  `  → the date gate alone would ${t7PostLaunch.length ? 'MISS ' + t7PostLaunch.length : 'catch all'}; the marker is ${t7PostLaunch.length ? 'load-bearing' : 'belt-and-braces'}`,
);
for (const r of t7PostLaunch.slice(0, 10)) {
  console.log(`    ${r.publishedAt.slice(0, 10)}  ${r.id}  ${r.title}`);
}
if (neither.length) {
  console.log('\n  Tekken uploads with no version token (sample):');
  for (const r of neither.slice(0, 10)) {
    console.log(`    ${r.publishedAt.slice(0, 10)}  ${r.id}  ${r.title}`);
  }
}

// ── gate the corpus down, counting at every step ─────────────────────────────
// Same predicates and same ORDER as scripts/parse.ts's per-video loop
// (parse.ts:298-314), so a number here is comparable to a number in
// data/report.md — with the game marker prepended, which parse.ts does not have.
const gates: { label: string; kept: number; dropped: number }[] = [];
const step = (label: string, input: EvoRecord[], keep: (r: EvoRecord) => boolean) => {
  const out = input.filter(keep);
  gates.push({ label, kept: out.length, dropped: input.length - out.length });
  return out;
};

let cur = all;
gates.push({ label: 'all uploads', kept: cur.length, dropped: 0 });
cur = step('is-TEKKEN-8 (title or description)', cur, (r) => marked(r, T8_RE));
cur = step('not TEKKEN 7', cur, (r) => !marked(r, T7_RE));
const tekken = cur;
cur = step('not live/upcoming', cur, (r) => r.liveBroadcastContent === 'none' && r.durationSec > 0);
cur = step('not #shorts', cur, (r) => !/#shorts?\b/i.test(r.title));
cur = step('duration ≥ 120s', cur, (r) => r.durationSec >= 120);
cur = step(
  `published ≥ ${LAUNCH} (pre-launch gate)`,
  cur,
  (r) => r.publishedAt.slice(0, 10) >= LAUNCH,
);

const w = Math.max(...gates.map((g) => g.label.length));
console.log('\n── gate table ─────────────────────────────────────────');
for (const g of gates) {
  console.log(
    `  ${g.label.padEnd(w)}  ${String(g.kept).padStart(5)}` +
      (g.dropped ? `   (−${g.dropped})` : ''),
  );
}

const byYear = new Map<string, EvoRecord[]>();
for (const r of cur) {
  const y = r.publishedAt.slice(0, 4);
  (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(r);
}
console.log('\n── T8-marked survivors by upload year ─────────────────');
for (const [y, rs] of [...byYear.entries()].sort()) console.log(`  ${y}: ${rs.length}`);

const durs = cur.map((r) => r.durationSec).sort((a, b) => a - b);
const pct = (p: number) => durs[Math.floor((durs.length - 1) * p)] ?? 0;
console.log(
  `\n  duration: min ${fmt(durs[0] ?? 0)} · p25 ${fmt(pct(0.25))} · median ${fmt(pct(0.5))} · p75 ${fmt(pct(0.75))} · max ${fmt(durs[durs.length - 1] ?? 0)}`,
);

await writeFile(join(CACHE, 'tekken-candidates.json'), JSON.stringify(cur, null, 1) + '\n', 'utf8');

// ── match shape ──────────────────────────────────────────────────────────────
// Evo's title grammar is per-EVENT, not per-game, so the SF6 approach carries:
// split on "|" and find the ONE segment carrying a versus. The players are
// always inside a single segment; the game name and round are always in others.
// That survives Evo reshuffling segment order between years, which it has done
// three times.
const GAME_RE = /^(?:tekken\s*8|t8|鉄拳\s*8)$/i;
const VS_SPLIT = /\s+(?:vs\.?|versus)\s+/i;

// Non-match footage that ALSO carries a versus. The vs-shape gate already
// excludes every stream VOD, bracket compilation, best-of and intro — none of
// them put "A vs B" in a segment — so this list stays narrow on purpose.
//
// It must NOT contain "Top \d+": Evo writes the bracket round as "Top 24" /
// "Top 96" / "Losers Top 8", so a Top-N filter here eats real single matches.
// "Top 8" alone with no versus is the compilation, and the shape gate has it.
// (SF6 measured this costing six real matches; the trap is Evo-wide, not
// game-specific, so it is inherited rather than re-derived.)
//
// DELIBERATELY NOT LISTED: "showcase". Evo 2024's "TEKKEN 8 Evo Showcase |
// LilyPichu vs Harada" (eNk2TsBgyOg) is the Sajam Slam "Beat a Pro" challenge —
// a streamer against the game's own producer, so neither side is a bracket
// entrant. It is nonetheless a real, readable Tekken 8 match and is INCLUDED by
// decision (2026-08-06). To exclude it again, add '\\bshowcase\\b' to this list:
// that is the whole change, and it costs exactly this one video. (The six other
// "Evo TEKKEN 8 Showcase" uploads, Nov 2023, are pre-release-build footage
// already excluded by the pre-launch date gate, so they are unaffected either
// way.)
const NOT_A_MATCH_RE = new RegExp(
  [
    '\\bOG\\s*Hunt\\b',
    'watch\\s*party',
    '\\bbest\\s*of\\b',
    '\\bintro\\b',
    'dev\\s*panel',
    'road\\s+to\\s+evo',
    'matches\\s+you\\s+missed',
    '\\brecap\\b',
    'highlights?',
  ].join('|'),
  'i',
);

// A single bracket match runs 6–25 min. Longer vs-titled uploads are
// exhibitions/showcases (an FT10), a different extraction problem — deferred
// rather than silently dropped.
const MAX_MATCH_SEC = 30 * 60;

interface EvoTitle {
  event: string;
  round: string | null;
  handles: [string, string];
}

function parseEvoTitle(title: string): EvoTitle | null {
  const segs = title
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length < 2) return null;

  // "Evo Japan 2026: …" — the event prefix rides on whichever segment is first,
  // which differs by grammar, so strip it wherever it appears.
  const stripEvent = (s: string) => {
    const i = s.indexOf(':');
    return i === -1 ? s : s.slice(i + 1).trim();
  };
  const event = (/^([^:|]*\b(?:evo)\b[^:|]*)/i.exec(title)?.[1] ?? '').trim();
  if (!event) return null;

  const vsIdx = segs.findIndex((s) => VS_SPLIT.test(stripEvent(s)));
  if (vsIdx === -1) return null;
  // exactly one versus segment, and exactly two sides within it
  if (segs.filter((s) => VS_SPLIT.test(stripEvent(s))).length !== 1) return null;
  const parts = stripEvent(segs[vsIdx]!).split(VS_SPLIT);
  if (parts.length !== 2) return null;
  const [a, b] = parts.map((p) => p.trim());
  if (!a || !b || a.length > 40 || b.length > 40) return null;

  let round: string | null = null;
  for (const [i, s] of segs.entries()) {
    if (i === vsIdx) continue;
    const rest = stripEvent(s)
      .replace(/tekken\s*8|鉄拳\s*8|\bt8\b/gi, '')
      .trim();
    if (rest && !GAME_RE.test(rest)) {
      round = rest;
      break;
    }
  }
  return { event, round, handles: [a, b] };
}

const excluded: { r: EvoRecord; why: string }[] = [];
const matches: { r: EvoRecord; t: EvoTitle }[] = [];
for (const r of cur) {
  // SHAPE FIRST — it is the strongest signal, and the marker list below only
  // catches what survives it.
  const t = parseEvoTitle(r.title);
  if (!t) {
    excluded.push({ r, why: 'no vs-shape (stream/compilation/best-of/intro)' });
    continue;
  }
  if (NOT_A_MATCH_RE.test(r.title)) {
    excluded.push({ r, why: 'vs-titled but not one match' });
    continue;
  }
  if (r.durationSec > MAX_MATCH_SEC) {
    excluded.push({ r, why: `long-form (${fmt(r.durationSec)}) — exhibition, deferred` });
    continue;
  }
  matches.push({ r, t });
}

console.log('\n── match-shape gate ───────────────────────────────────');
console.log(`  T8 candidates in            ${cur.length}`);
console.log(`  excluded                    ${excluded.length}`);
console.log(`  MATCH-SHAPED                ${matches.length}`);

const byEvent = new Map<string, number>();
for (const m of matches) byEvent.set(m.t.event, (byEvent.get(m.t.event) ?? 0) + 1);
console.log('\n── match-shaped by event ──────────────────────────────');
for (const [e, n] of [...byEvent.entries()].sort()) console.log(`  ${e.padEnd(24)} ${n}`);

const mdurs = matches.map((m) => m.r.durationSec).sort((a, b) => a - b);
console.log(
  `\n  duration: min ${fmt(mdurs[0] ?? 0)} · median ${fmt(mdurs[Math.floor((mdurs.length - 1) / 2)] ?? 0)} · max ${fmt(mdurs[mdurs.length - 1] ?? 0)}`,
);
console.log(`  total footage: ${Math.round(mdurs.reduce((a, b) => a + b, 0) / 60)} min`);

console.log(`\n── the corpus (${matches.length}) ────────────────────────────────`);
for (const { r, t } of [...matches].sort((x, y) => (x.r.publishedAt < y.r.publishedAt ? -1 : 1))) {
  console.log(
    `  ${r.publishedAt.slice(0, 10)} ${fmt(r.durationSec).padStart(7)} ${r.id}  ${t.handles[0]} vs ${t.handles[1]}  ${t.round ? `[${t.round}]` : '[—]'}`,
  );
}

console.log(`\n── excluded (${excluded.length}) ──────────────────────────────────`);
for (const { r, why } of excluded) console.log(`  ${why.padEnd(38)} ${r.title}`);

await writeFile(
  join(CACHE, 'corpus.json'),
  JSON.stringify(
    matches.map(({ r, t }) => ({
      id: r.id,
      title: r.title,
      publishedAt: r.publishedAt,
      durationSec: r.durationSec,
      event: t.event,
      round: t.round,
      handles: t.handles,
    })),
    null,
    1,
  ) + '\n',
  'utf8',
);

console.log(
  `\n✔ cache/evo/enumeration.json (${all.length}) · tekken-candidates.json (${cur.length}) · corpus.json (${matches.length})`,
);
console.log(`  T8-marked before the structural gates: ${tekken.length}`);
