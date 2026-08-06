// Stage 2: parse raw/<channel>.json into the committed substrate
// (data/videos.json), derive the player registry (data/players.json), tune
// the season boundaries, write the coverage report, then emit the generic
// schema (scripts/emit.ts).
//
// Title contract (all tracked channels, ≥98% of uploads):
//   … PLAYER_A (qualifiers CharacterA) vs PLAYER_B (qualifiers CharacterB) …
// Ladder ranks come from the DESCRIPTIONS ("Keisuke (God of Destruction 6
// Kazuya) Versus Mevius (…)"); title qualifiers are leaderboard positions
// ("#6 Ranked", "Ranked #4", "High Ranked") which are NOT ladder ranks and
// are ignored. GoD sub-tiers normalize onto the 30-rank ladder (roster.ts).
//
// Run: npm run data:parse   (pure: no network, no API key)

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS } from './channels';
import { applyOverrides, emitGeneric } from './emit';
import { buildPatchTable } from './patches';
import { buildAliasMatcher, extractRank, loadCharacters } from './roster';
import type {
  MatchSide,
  MatchVideo,
  PatchBoundary,
  PlayerRecord,
  RawVideoRecord,
  SeasonBoundary,
  VideoOverride,
} from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

// ── season boundaries: AUTHORITATIVE patch dates (verified against Bandai
//    Namco's announcements — S1 = launch 2024-01-26, S2 = patch 2.00
//    2025-03-31, S3 = patch 3.00 2026-03-17). Channel season labels are
//    treated as CONFIRMATION only: near a boundary (±GRACE days) a label may
//    override the date (matches upload later than they're played); farther
//    out the date wins and the conflict is reported — recon showed channels
//    pre-labeling "(SEASON 3)" weeks before the patch, and tournament names
//    ("STL S2") masquerading as season tags. Extend this table when a new
//    season ships (the report's season-label-conflict counter will call it
//    out); it is persisted to data/seasonBoundaries.json for reference. ─────
const S1_START = '2024-01-26';
const SEASONS: SeasonBoundary[] = [
  { season: 1, start: S1_START, end: '2025-03-31' },
  { season: 2, start: '2025-03-31', end: '2026-03-17' },
  { season: 3, start: '2026-03-17', end: null },
];
const LABEL_GRACE_DAYS = 14;

// ── patch boundaries: the per-patch layer under SEASONS (engine v0.6.0
//    grouped facet). data/patchBoundaries.json is wavu-authored + folded;
//    buildPatchTable validates it against SEASONS (the season authority) and
//    scripts/patches.ts's header carries the Bandai replay-expiry accuracy
//    basis for date-derivation. Season resolution below is UNCHANGED — the
//    label grace stays; a grace-flipped season simply nulls patchVersion in
//    the normalize step ("season known, patch unknown"). ────────────────────
const patchTable = buildPatchTable(
  SEASONS,
  (
    JSON.parse(await readFile(join(DATA, 'patchBoundaries.json'), 'utf8')) as {
      patches: PatchBoundary[];
    }
  ).patches,
);

// Curated famous-pro list (marks Player.featured when present in the data —
// harmless for ids that never appear).
const FEATURED = new Set([
  'knee',
  'qudans',
  'ulsan',
  'arslan-ash',
  'chikurin',
  'nobi',
  'rangchu',
  'lowhigh',
  'joka',
  'mulgold',
  'yagami',
  'atif-butt',
  'awais-honey',
  'khan',
  'book',
  'kkokkoma',
  'jdcr',
  'eyemusician',
  'ninjakilla',
  'raef',
  'reda',
  'keisuke',
  'pling',
  'sephiblack',
  'ayorichie',
  'jodd',
]);

// ── small utils ──────────────────────────────────────────────────────────────
const slug = (handle: string): string =>
  handle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const isUpper = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();

// ── esports org tags ─────────────────────────────────────────────────────────
// Channels prepend the player's team to the handle ("KDF Mulgold", "DRX Knee",
// "VIT JeonDDing"), which would otherwise mint a separate player id — and a
// separate player page — per sponsor. Worse, it fragments across TIME: Mulgold
// appears as KDF, DNF and bare, so one pro's matches would land on three pages.
//
// This list is CURATED, not inferred, and that is deliberate. The obvious
// heuristic — "leading token whose remainder is a handle seen standalone" —
// scores ARSLAN ASH → ASH (135 sides), NINA ASSASSIN → ASSASSIN, PARK DUCKSIK,
// BUFFALO SOLDIER, TEKKEN MASTER and LIL MAJIN, none of which are org tags:
// handles like "Ash", "Master" and "Majin" are simply common enough to belong
// to somebody else too. A wrong merge silently rewrites a real player's page,
// so entries earn their place by being recognizable Tekken/FGC organizations.
// Add new ones as rosters change; ambiguous leading words stay out.
const ORG_PREFIXES = new Set([
  'aeg',
  'drx',
  'dnf',
  'falcons',
  'faze',
  'fate',
  'kdf',
  'lmg',
  'md',
  'mtbt',
  'pbe',
  'rb',
  't1',
  'talon',
  'thy',
  'top',
  'varrel',
  'vit',
  'yamasa',
  'zeta',
]);

/** Drop leading org tags ("VIT JeonDDing" → "JeonDDing"). Loops so stacked
 *  tags collapse, and never strips a handle down to nothing. */
function stripOrgPrefix(handle: string): string {
  let h = handle;
  for (;;) {
    const m = /^([A-Za-z0-9]{1,9})[\s|]+(\S.*)$/.exec(h);
    if (!m || !ORG_PREFIXES.has(m[1]!.toLowerCase())) return h;
    h = m[2]!.trim();
  }
}

// ── title parsing ────────────────────────────────────────────────────────────
const VS_RE = /(.+?)\(([^()]{1,60})\)\s*(?:vs\.?|versus)\s*(.+?)\(([^()]{1,60})\)/iu;
// channel-brand segment delimiters seen in the tracked channels' titles
const SEG_RE = /[▰🔥⚡•▶►|]+/u;

function cleanHandle(raw: string): string | null {
  let t = raw.split(SEG_RE).pop() ?? '';
  t = t.split(/\s[-–—]\s/).pop() ?? '';
  t = stripOrgPrefix(
    t
      .replace(/^[\s,.:;–—-]+/u, '')
      .replace(/[\s,.:;–—-]+$/u, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!t || t.length > 40) return null;
  return t;
}

interface TitleSides {
  handles: [string, string];
  parens: [string, string];
}
function parseTitle(title: string): TitleSides | null {
  const m = VS_RE.exec(title);
  if (!m) return null;
  const a = cleanHandle(m[1]!);
  const b = cleanHandle(m[3]!);
  if (!a || !b) return null;
  return { handles: [a, b], parens: [m[2]!, m[4]!] };
}

// ── description side pass (ladder ranks + nicer handle casing) ───────────────
const DESC_RE =
  /([^():\n!]{1,50}?)\s*\(([^()\n]{1,90})\)\s*(?:versus|vs\.?)\s*([^():\n!]{1,50}?)\s*\(([^()\n]{1,90})\)/iu;

interface DescSide {
  handle: string;
  character: string | null;
  rank?: string;
}
function parseDescSides(
  description: string,
  matcher: ReturnType<typeof buildAliasMatcher>,
): [DescSide, DescSide] | null {
  const m = DESC_RE.exec(description);
  if (!m) return null;
  // org tags are stripped here too: the description handle is matched against
  // the title's by slug, so both sides must normalize the same way or the
  // nicer description casing is lost.
  const side = (name: string, paren: string): DescSide => ({
    handle: stripOrgPrefix(name.replace(/\s+/g, ' ').trim()),
    character: matcher.one(paren),
    ...(extractRank(paren) ? { rank: extractRank(paren) } : {}),
  });
  return [side(m[1]!, m[2]!), side(m[3]!, m[4]!)];
}

// ── explicit season labels (confirmation only, see SEASONS) ──────────────────
// Title form must be adjacent to the game tag ("T8 S3", "Tekken 8 S3",
// "Tekken 8 (SEASON 3)") so tournament seasons ("STL S2 DAY4") don't match.
function labeledSeason(r: RawVideoRecord): number | null {
  const t = /\b(?:T8|TE?KKE?N\s*8)\s*(?:\(\s*SEASON\s*([1-9])\s*\)|S([1-9])\b)/i.exec(r.title);
  if (t) return Number(t[1] ?? t[2]);
  const d = /\bSEASON\s*([1-9])\b/i.exec(r.description);
  if (d) return Number(d[1]);
  return null;
}

function seasonForDate(date: string): number {
  for (const b of [...SEASONS].reverse()) {
    if (date >= b.start && (b.end === null || date < b.end)) return b.season;
  }
  return SEASONS[0]!.season;
}

const dayDiff = (a: string, b: string): number =>
  Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400_000;

/** Date-derived season, with a channel label honored only near the label's
 *  own boundary (uploads lag the matches they contain). Far-out disagreements
 *  are label noise → the date wins, counted for the report. */
let labelConflicts = 0;
function resolveSeason(date: string, label: number | null): number {
  const byDate = seasonForDate(date);
  if (label === null || label === byDate) return byDate;
  const labelStart = SEASONS.find((b) => b.season === label)?.start;
  const byDateStart = SEASONS.find((b) => b.season === byDate)?.start;
  const nearBoundary =
    (labelStart && dayDiff(date, labelStart) <= LABEL_GRACE_DAYS) ||
    (byDateStart && dayDiff(date, byDateStart) <= LABEL_GRACE_DAYS);
  if (nearBoundary) return label;
  labelConflicts++;
  return byDate;
}

// ── main ─────────────────────────────────────────────────────────────────────
const characters = await loadCharacters();
const matcher = buildAliasMatcher(characters);

/** intake channel → the source its replays publish under (several channels
 *  may share one, e.g. every event organizer feeds 'tournament'). */
const SOURCE_OF = new Map(CHANNELS.map((c) => [c.id, c.source]));

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const raws: RawVideoRecord[] = [];
for (const ch of CHANNELS) {
  const path = join(ROOT, 'raw', `${ch.id}.json`);
  try {
    raws.push(...(await readJson<RawVideoRecord[]>(path)));
  } catch {
    console.error(`✖ ${path} missing/unreadable — run \`npm run data:fetch\` first.`);
    process.exit(1);
  }
}
const overrides = await readJson<Record<string, VideoOverride>>(join(DATA, 'overrides.json')).catch(
  () => ({}) as Record<string, VideoOverride>,
);

type MissReason =
  | 'live-or-upcoming'
  | 'shorts'
  | 'short-duration'
  | 'pre-launch'
  | 'no-vs-title'
  | 'char-unresolved'
  | 'bad-handle';
const misses: { id: string; channel: string; reason: MissReason; title: string }[] = [];
const miss = (r: RawVideoRecord, reason: MissReason) =>
  misses.push({ id: r.id, channel: r.channel, reason, title: r.title });

interface Candidate {
  raw: RawVideoRecord;
  handles: [string, string];
  chars: [string, string];
  ranks: [string | undefined, string | undefined];
  descHandles: [string | undefined, string | undefined];
  label: number | null;
}
const candidates: Candidate[] = [];

for (const r of raws) {
  if (r.liveBroadcastContent !== 'none' || r.durationSec === 0) {
    miss(r, 'live-or-upcoming');
    continue;
  }
  if (/#shorts?\b/i.test(r.title)) {
    miss(r, 'shorts');
    continue;
  }
  if (r.durationSec < 120) {
    miss(r, 'short-duration');
    continue;
  }
  if (r.publishedAt.slice(0, 10) < S1_START) {
    miss(r, 'pre-launch');
    continue;
  }
  const t = parseTitle(r.title);
  if (!t) {
    miss(r, 'no-vs-title');
    continue;
  }
  const charA = matcher.one(t.parens[0]);
  const charB = matcher.one(t.parens[1]);
  if (!charA || !charB) {
    miss(r, 'char-unresolved');
    continue;
  }
  if (!slug(t.handles[0]) || !slug(t.handles[1])) {
    miss(r, 'bad-handle');
    continue;
  }

  // description pass: ladder ranks + nicer casing, aligned to the title sides
  let ranks: Candidate['ranks'] = [undefined, undefined];
  let descHandles: Candidate['descHandles'] = [undefined, undefined];
  const desc = parseDescSides(r.description, matcher);
  if (desc) {
    const [d0, d1] = desc;
    let order: [DescSide, DescSide] | null = null;
    if (d0.character === charA && d1.character === charB) {
      // mirror matchups (charA === charB) are order-ambiguous by character
      // alone — require a handle correspondence before trusting the order
      order = charA !== charB || slug(d0.handle) === slug(t.handles[0]) ? [d0, d1] : null;
      if (!order && slug(d1.handle) === slug(t.handles[0])) order = [d1, d0];
    } else if (d0.character === charB && d1.character === charA) {
      order = [d1, d0];
    }
    if (order) {
      ranks = [order[0].rank, order[1].rank];
      descHandles = [
        slug(order[0].handle) === slug(t.handles[0]) ? order[0].handle : undefined,
        slug(order[1].handle) === slug(t.handles[1]) ? order[1].handle : undefined,
      ];
    }
  }

  candidates.push({
    raw: r,
    handles: t.handles,
    chars: [charA, charB],
    ranks,
    descHandles,
    label: labeledSeason(r),
  });
}

// ── player registry: best casing (description mixed-case beats ALL-CAPS
//    titles), frequency as the tiebreak ───────────────────────────────────────
const casing = new Map<string, Map<string, number>>(); // id → variant → count
function noteHandle(id: string, variant: string, weight: number) {
  const m = casing.get(id) ?? new Map<string, number>();
  m.set(variant, (m.get(variant) ?? 0) + weight);
  casing.set(id, m);
}

const videos: MatchVideo[] = candidates.map((c) => {
  const sides = c.chars.map((character, i) => {
    const handle = c.handles[i]!;
    const id = slug(handle);
    noteHandle(id, handle, 1);
    const dh = c.descHandles[i];
    if (dh && !isUpper(dh)) noteHandle(id, dh, 1000); // desc casing wins
    return {
      player: id,
      handle,
      // A title-parsed side names exactly one character; the array is the union
      // shape a footage-read set VOD needs (see MatchSide), and length-1 is the
      // ordinary case rather than a special one.
      characters: [character],
      ...(c.ranks[i] ? { rank: c.ranks[i] } : {}),
    } as MatchSide;
  }) as [MatchSide, MatchSide];
  return {
    id: c.raw.id,
    channel: SOURCE_OF.get(c.raw.channel)!,
    intake: c.raw.channel,
    title: c.raw.title,
    publishedAt: c.raw.publishedAt,
    durationSec: c.raw.durationSec,
    ...(c.raw.viewCount !== undefined ? { viewCount: c.raw.viewCount } : {}),
    season: resolveSeason(c.raw.publishedAt.slice(0, 10), c.label),
    patchVersion: patchTable.patchForDate(c.raw.publishedAt)?.version ?? null,
    sides,
  };
});
videos.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));

// Hierarchy consistency normalize (after label-grace and overrides settled
// season): a patchVersion whose release-date season contradicts the record's
// season becomes null — emitted as the bare era token, "season known, patch
// unknown", matching whole-season selections but never a specific patch.
const records = applyOverrides(videos, overrides).map((v) =>
  v.patchVersion !== null && patchTable.seasonOfPatch(v.patchVersion) !== v.season
    ? { ...v, patchVersion: null }
    : v,
);

// registry from the post-override records; best casing per id
const playerIds = new Map<string, string>(); // id → best handle
for (const [id, variants] of casing) {
  const best = [...variants.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  playerIds.set(id, best);
}
const seen = new Set<string>();
for (const v of records) for (const s of v.sides) seen.add(s.player);
const players: PlayerRecord[] = [...seen].sort().map((id) => ({
  id,
  handle: playerIds.get(id) ?? id,
  ...(FEATURED.has(id) ? { featured: true } : {}),
}));

// normalize side handles to the registry's chosen casing
for (const v of records) for (const s of v.sides) s.handle = playerIds.get(s.player) ?? s.handle;

// ── write artifacts ──────────────────────────────────────────────────────────
await writeFile(join(DATA, 'videos.json'), JSON.stringify(records, null, 1) + '\n', 'utf8');
await writeFile(join(DATA, 'players.json'), JSON.stringify(players, null, 2) + '\n', 'utf8');
await writeFile(
  join(DATA, 'seasonBoundaries.json'),
  JSON.stringify(SEASONS, null, 2) + '\n',
  'utf8',
);

// ── report ───────────────────────────────────────────────────────────────────
// records carry the SOURCE, so coverage is counted back through the intake
// channel each video came from (sources may aggregate several channels).
const channelOf = new Map(raws.map((r) => [r.id, r.channel]));
const byChannel = (id: string) => ({
  raw: raws.filter((r) => r.channel === id).length,
  parsed: records.filter((v) => channelOf.get(v.id) === id).length,
  missed: misses.filter((m) => m.channel === id),
});
const rankSides = records.reduce((n, v) => n + v.sides.filter((s) => s.rank).length, 0);
const seasonDist = records.reduce<Record<string, number>>((acc, v) => {
  acc[`S${v.season}`] = (acc[`S${v.season}`] ?? 0) + 1;
  return acc;
}, {});
const reasonCounts = misses.reduce<Record<string, number>>((acc, m) => {
  acc[m.reason] = (acc[m.reason] ?? 0) + 1;
  return acc;
}, {});

const report = [
  '# Tekken pipeline report',
  '',
  `**${records.length} matches** parsed from ${raws.length} uploads across ${CHANNELS.length} channels · ` +
    `${players.length} players · ranked sides ${rankSides}/${records.length * 2} (${((rankSides / (records.length * 2)) * 100).toFixed(1)}%)`,
  '',
  '| channel | source | uploads | parsed | coverage |',
  '| --- | --- | ---: | ---: | ---: |',
  ...CHANNELS.map((ch) => {
    const s = byChannel(ch.id);
    return `| ${ch.id} | ${ch.source} | ${s.raw} | ${s.parsed} | ${((s.parsed / Math.max(1, s.raw)) * 100).toFixed(1)}% |`;
  }),
  '',
  `Seasons: ${Object.entries(seasonDist)
    .sort()
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ')}`,
  '',
  `Patches: ${Object.entries(
    records.reduce<Record<string, number>>((acc, v) => {
      acc[v.patchVersion ?? 'unknown'] = (acc[v.patchVersion ?? 'unknown'] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ')} (unknown = season contradicts the date: label-grace/override)`,
  '',
  `Misses by reason: ${
    Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ') || 'none'
  }`,
  '',
  `Season-label conflicts (channel label ≠ date-derived season, outside the ±${LABEL_GRACE_DAYS}d boundary grace; date wins): ${labelConflicts}`,
  '',
  '## Sample misses (first 30 that are not shorts/live)',
  '',
  ...misses
    .filter((m) => m.reason !== 'shorts' && m.reason !== 'live-or-upcoming')
    .slice(0, 30)
    .map((m) => `- \`${m.id}\` [${m.channel}] ${m.reason}: ${m.title.slice(0, 110)}`),
  '',
  `_Generated ${new Date().toISOString()}_`,
  '',
].join('\n');
await writeFile(join(DATA, 'report.md'), report, 'utf8');

console.log(
  `✔ Parsed ${records.length}/${raws.length} uploads → data/videos.json (misses: ${misses.length}; see data/report.md)`,
);
console.log(
  `  seasons ${Object.entries(seasonDist)
    .sort()
    .map(([k, n]) => `${k}:${n}`)
    .join(
      ' ',
    )} · boundaries ${SEASONS.map((b) => `S${b.season}@${b.start}`).join(' ')} · label conflicts ${labelConflicts}`,
);

// ── emit the generic schema (same code path as `npm run data:emit`) ──────────
await emitGeneric({ records, characters, players, root: ROOT });
