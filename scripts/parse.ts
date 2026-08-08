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
  ChannelConfig,
  MatchSide,
  MatchVideo,
  ReviewQueueItem,
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
/** intake channel → its whole config, for the per-channel behaviour flags
 *  (gameSignal, charactersFromFootage). */
const CHANNEL_OF = new Map(CHANNELS.map((c) => [c.id, c]));

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

// ── the game marker (gameSignal channels only) ───────────────────────────────
// The four original channels are Tekken-only by construction, so this pipeline
// never needed a game predicate. Evo runs every game at the event, so an upload
// from a gameSignal channel must say TEKKEN 8 and must not say TEKKEN 7.
//
// SPELLED FORMS ONLY — no bare \bT8\b. On that channel "T8" overwhelmingly
// means TOP 8: 26 titles carry a bare T8 and 23 of them are "ST 3v3 EVO 2014:
// T8 Quarters" (Super Turbo) or multi-game stream VODs. Measured against the
// full enumeration, the bare token admits ZERO uploads the spelled form does
// not already match — all false positive, no signal.
//
// BOTH GATES ARE LOAD-BEARING. Tekken 8 launched 2024-01-26, so Evo 2023's
// Tekken is Tekken 7 and the pre-launch date gate excludes it — but two
// T7-marked uploads POST-DATE the launch ("LowHigh wins Evo 2018"), which the
// date gate alone would let through. A T7 match read against the T8 roster is
// silent garbage: most of the T7 cast is still on the roster, so a wrong read
// looks entirely plausible.
const T8_RE = /\bTEKKEN\s*8\b|鉄拳\s*8/i;
const T7_RE = /\bTEKKEN\s*7\b|鉄拳\s*7/i;
const isTekken8 = (r: RawVideoRecord, cfg: ChannelConfig): boolean => {
  if (!cfg.gameSignal) return true; // Tekken-only channel: nothing to test
  const text = `${r.title}\n${r.description}`;
  return T8_RE.test(text) && !T7_RE.test(text);
};

// ── footage-title parsing (charactersFromFootage channels) ───────────────────
// Evo states players, game and round but never a character, in grammars that
// have been reshuffled three times across 2024→2026, all delimited by "|":
//   "Evo Japan 2025: Tekken 8 | ULSAN vs Rangchu"
//   "Evo 2026: NOBI vs Meo-IL | TEKKEN 8 | Losers Round 1"
// Rather than a regex per grammar, split on "|" and take the ONE segment
// carrying a versus — the players always sit inside a single segment, the game
// name and round always in others.
//
// The versus shape alone excludes every stream VOD, bracket compilation,
// best-of and intro on the channel, so NOT_A_MATCH_RE stays narrow: it only has
// to catch the non-matches that ALSO carry a versus. It must never test
// "Top \d+" — Evo writes the bracket round as "Top 24" / "Losers Top 8", and
// filtering on that eats real single matches.
const FOOTAGE_VS = /\s+(?:vs\.?|versus)\s+/i;
const NOT_A_MATCH_RE =
  /\bOG\s*Hunt\b|watch\s*party|\bbest\s*of\b|\bintro\b|dev\s*panel|road\s+to\s+evo|matches\s+you\s+missed|\brecap\b|highlights?/i;
/** A bracket set runs 5–25 min here. Longer versus-titled uploads are
 *  exhibitions where a player may change character freely across many games —
 *  a different problem, deferred rather than silently mis-recorded. */
const MAX_SET_SEC = 30 * 60;

function footageTitle(title: string): [string, string] | null {
  if (NOT_A_MATCH_RE.test(title)) return null;
  const segs = title
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length < 2) return null;
  // the "Evo Japan 2026:" event prefix rides on whichever segment is first,
  // which differs by grammar, so strip it wherever it appears
  const noEvent = (s: string) => {
    const i = s.indexOf(':');
    return i === -1 ? s : s.slice(i + 1).trim();
  };
  const withVs = segs.filter((s) => FOOTAGE_VS.test(noEvent(s)));
  if (withVs.length !== 1) return null;
  const parts = noEvent(withVs[0]!).split(FOOTAGE_VS);
  if (parts.length !== 2) return null;
  const a = parts[0]!.trim();
  const b = parts[1]!.trim();
  if (!a || !b || a.length > 40 || b.length > 40) return null;
  return [a, b];
}

// Handle VARIANTS, which no normalization can catch: a suffix is not a spelling
// difference. Evo writes "Ninjakilla_212" (the player's full FGC handle); the
// four Tekken channels write "Ninjakilla", which already owns 100+ replays.
// Without this the Evo verdicts slug to `ninjakilla-212` and build a second
// page for the same competitor.
//
// CURATED, NOT INFERRED — the same discipline ORG_PREFIXES documents above, and
// for the same reason: a wrong merge silently rewrites a real player's page.
const HANDLE_ALIASES = new Map<string, string>([
  ['ninjakilla_212', 'Ninjakilla'], // Evo 2026 Losers Round 1 vs JeonDDing
]);

type MissReason =
  | 'not-tekken8'
  | 'live-or-upcoming'
  | 'shorts'
  | 'short-duration'
  | 'pre-launch'
  | 'no-vs-title'
  | 'char-unresolved'
  | 'bad-handle';
const misses: { id: string; channel: string; reason: MissReason; title: string }[] = [];
// Misses stay reachable by id so the character-completion path below can build
// a record from raw + a sides verdict in overrides.json.
const missedById = new Map<string, RawVideoRecord>();
const miss = (r: RawVideoRecord, reason: MissReason) => {
  misses.push({ id: r.id, channel: r.channel, reason, title: r.title });
  missedById.set(r.id, r);
};
// Match-shaped uploads on a charactersFromFootage channel, awaiting a character
// verdict. Held aside rather than queued in place because the queue wants the
// CANONICAL handle spelling, and that is only known once the player registry is
// built from the whole parsed corpus below.
const footagePending: { raw: RawVideoRecord; handles: [string, string] }[] = [];

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
  if (!isTekken8(r, CHANNEL_OF.get(r.channel)!)) {
    miss(r, 'not-tekken8');
    continue;
  }
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
    // A channel whose titles never name a character (charactersFromFootage): a
    // match-shaped upload is not a parse failure, it is a completion item. It
    // still goes through miss() — that is what registers it in missedById,
    // which is what lets a sides verdict build the record later — but it is
    // subtracted from the REPORTED misses below.
    const cfg = CHANNEL_OF.get(r.channel)!;
    if (cfg.charactersFromFootage && r.durationSec <= MAX_SET_SEC) {
      const handles = footageTitle(r.title);
      const ov = overrides[r.id];
      // an id already carrying a verdict must not be re-queued; an excluded one
      // must not be queued at all. This is what makes the queue self-clearing.
      if (handles && !ov?.sides && ov?.exclude !== true) {
        footagePending.push({ raw: r, handles });
      }
    }
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
// ── character-completion: records built from a footage verdict ───────────────
// An overrides.json entry with a complete sides pair on a MISSED id is
// authoritative — the record is built from raw + override with the title gates
// bypassed by design, because the title never had the characters in it. Ids
// that parsed normally take their sides override through applyOverrides
// instead, and ids absent from raw/ cannot be completed at all: a record needs
// the upload's own metadata.
//
// Rank is never set here. These are offline tournament sets with no ladder
// rank on screen, and MatchSide.rank is optional precisely so a source that
// does not state one can ship without inventing it.
const completedIds = new Set<string>();
for (const [id, ov] of Object.entries(overrides)) {
  if (!ov.sides || ov.exclude) continue;
  const r = missedById.get(id);
  if (!r) continue;
  completedIds.add(id);
  for (const s of ov.sides) noteHandle(s.player, s.handle, 1);
  const season = resolveSeason(r.publishedAt.slice(0, 10), labeledSeason(r));
  videos.push({
    id,
    channel: SOURCE_OF.get(r.channel)!,
    intake: r.channel,
    title: r.title,
    publishedAt: r.publishedAt,
    durationSec: r.durationSec,
    ...(r.viewCount !== undefined ? { viewCount: r.viewCount } : {}),
    season,
    patchVersion: patchTable.patchForDate(r.publishedAt)?.version ?? null,
    sides: ov.sides as [MatchSide, MatchSide],
  });
}

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

// ── channel-collapse guard ────────────────────────────────────────────────────
// A tracked channel can vanish between refreshes — deleted, renamed, made
// private, or REBRANDED to another game with its back catalogue unlisted. The
// last of those actually happened: 2XKO's "Pro Replays" channel became "MARVEL
// TOKON Pro Replays" on 2026-08-07, its 1,317 uploads left the uploads playlist
// while still existing and still playing, and the cron published a catalogue
// 24% smaller — then treated it as the new baseline. Nothing stopped it.
//
// PARSED vs COMMITTED, not raw vs committed. 2XKO gates multi-game channels at
// FETCH, so its raw dump is already this-game-only and raw is a fair proxy for
// what will publish. This repo gates at PARSE, so raw holds every upload the
// channel ever made — telly is 12,427 raw against 7,516 committed — and a raw
// comparison would measure the game filter rather than the loss. Parsed records
// are what actually reach the site, so that is what is compared.
//
// TWO THRESHOLDS, BOTH REQUIRED. A percentage alone punishes a small channel for
// ordinary churn; an absolute alone misses a large channel bleeding slowly.
// Runs after `records` is final and before the first write, so a fired guard
// costs nothing and leaves the committed data intact.
const COLLAPSE_PCT = 0.1; // >10% of the committed count
const COLLAPSE_ABS = 20; // AND >20 records
{
  const allowIdx = process.argv.indexOf('--allow-collapse');
  const allowed = new Set(
    allowIdx === -1 ? [] : (process.argv[allowIdx + 1] ?? '').split(',').map((x) => x.trim()),
  );
  const committed = await readJson<typeof records>(join(DATA, 'videos.json')).catch(() => []);
  if (committed.length > 0) {
    const tally = (rs: typeof records): Map<string, number> => {
      const m = new Map<string, number>();
      for (const v of rs) {
        const k = (v as { intake?: string }).intake ?? v.channel;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    const before = tally(committed);
    const now = tally(records);
    const collapsed: string[] = [];
    for (const ch of CHANNELS) {
      // A channel's committed records may carry more than one token (a source
      // plus an eventSource), so sum every token this channel can produce.
      const tokens = [ch.id];
      const was = tokens.reduce((n, t) => n + (before.get(t) ?? 0), 0);
      if (was === 0) continue; // a new channel has no history to fall from
      const is = tokens.reduce((n, t) => n + (now.get(t) ?? 0), 0);
      const lost = was - is;
      if (lost > COLLAPSE_ABS && lost / was > COLLAPSE_PCT) {
        collapsed.push(
          `  ${ch.id}: ${was} → ${is}  (lost ${lost}, ${((lost / was) * 100).toFixed(1)}%)` +
            (allowed.has(ch.id) ? '  [allowed]' : ''),
        );
      }
    }
    const blocking = collapsed.filter((l) => !l.endsWith('[allowed]'));
    if (collapsed.length > 0) console.error('Channel collapse detected:\n' + collapsed.join('\n'));
    if (blocking.length > 0) {
      console.error(
        [
          ``,
          `✖ Refusing to write: a channel lost more than ${COLLAPSE_ABS} records AND more than`,
          `  ${COLLAPSE_PCT * 100}% of its committed count. Publishing this would bake the loss in,`,
          `  and the next run would treat the smaller number as the new normal.`,
          `  Check the channel before overriding — it may have been renamed, made private,`,
          `  or rebranded to another game (2XKO lost 1,317 records that way on 2026-08-07).`,
          ``,
          `  Accept the prune:  npm run data:parse -- --allow-collapse ${blocking.map((l) => l.trim().split(':')[0]).join(',')}`,
        ].join('\n'),
      );
      process.exit(1);
    }
  }
}

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

// ── the review queue ─────────────────────────────────────────────────────────
// Footage-completion items, now that canonical spellings exist. Pre-filling the
// handle with the corpus's own spelling is what stops a verdict minting a
// second player page for someone already in players.json — the review POST
// slugs whatever the form contains and does not run this file's identity merge.
const reviewQueue: ReviewQueueItem[] = [];
const footagePendingIds = new Set(footagePending.map((p) => p.raw.id));
for (const { raw, handles } of footagePending) {
  const canonical = (h: string): string => {
    const aliased = HANDLE_ALIASES.get(h.toLowerCase()) ?? h;
    return playerIds.get(slug(aliased)) ?? aliased;
  };
  reviewQueue.push({
    id: raw.id,
    kind: 'character-completion',
    channel: raw.channel,
    title: raw.title,
    publishedAt: raw.publishedAt,
    durationSec: raw.durationSec,
    handles: [canonical(handles[0]), canonical(handles[1])],
    reason: 'no title or description on this channel names a character',
  });
}
reviewQueue.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));

// A completed id is not a miss (the override built its record), and neither is
// one sitting in the queue awaiting a verdict — that is pending work, counted
// separately, not coverage the parser lost.
const reportedMisses = misses.filter(
  (m) => !completedIds.has(m.id) && !footagePendingIds.has(m.id),
);

// normalize side handles to the registry's chosen casing
for (const v of records) for (const s of v.sides) s.handle = playerIds.get(s.player) ?? s.handle;

// ── write artifacts ──────────────────────────────────────────────────────────
// Derived state, regenerated wholesale every run: resolutions live solely in
// overrides.json, so a resolved item simply stops being generated. Committed
// (and in the cron's git add) so the pending set is visible history and the
// /dev/source-review UI reads real substrate.
await writeFile(
  join(DATA, 'review-queue.json'),
  JSON.stringify(reviewQueue, null, 2) + '\n',
  'utf8',
);
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
  missed: reportedMisses.filter((m) => m.channel === id),
});
const rankSides = records.reduce((n, v) => n + v.sides.filter((s) => s.rank).length, 0);
const seasonDist = records.reduce<Record<string, number>>((acc, v) => {
  acc[`S${v.season}`] = (acc[`S${v.season}`] ?? 0) + 1;
  return acc;
}, {});
const reasonCounts = reportedMisses.reduce<Record<string, number>>((acc, m) => {
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
  `Pending review: ${reviewQueue.length} (data/review-queue.json)`,
  '',
  '## Sample misses (first 30 that are not shorts/live)',
  '',
  ...reportedMisses
    .filter((m) => m.reason !== 'shorts' && m.reason !== 'live-or-upcoming')
    .slice(0, 30)
    .map((m) => `- \`${m.id}\` [${m.channel}] ${m.reason}: ${m.title.slice(0, 110)}`),
  '',
  `_Generated ${new Date().toISOString()}_`,
  '',
].join('\n');
await writeFile(join(DATA, 'report.md'), report, 'utf8');

console.log(
  `✔ Parsed ${records.length}/${raws.length} uploads → data/videos.json ` +
    `(misses: ${reportedMisses.length}; pending review: ${reviewQueue.length}; see data/report.md)`,
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
