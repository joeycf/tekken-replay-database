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

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS, FETCHED_CHANNELS, stripTheaterSponsor } from './channels';
import { crossCheck, formatCrossCheck, type WitnessArtifact, type WitnessFile } from './crosscheck';
import { applyOverrides, emitGeneric } from './emit';
import { formatStaleRefusal, staleEvidence } from './freshness';
import { buildPatchTable } from './patches';
import { buildAliasMatcher, extractRank, loadCharacters } from './roster';
import { HANDLE_ALIASES, idKey, resolveKey, resolvePlayers, undeclaredCollisions } from './players';
import type {
  ChannelConfig,
  ChannelKey,
  MatchSide,
  MatchVideo,
  ReviewQueueItem,
  PatchBoundary,
  PlayerRecord,
  RawVideoRecord,
  SeasonBoundary,
  SourcePins,
  TheaterRawRecord,
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
/** Read a JSON object, or {} when the file does not exist yet. */
async function readJsonSafe(path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}
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
// Channel-brand segment delimiters seen in the tracked channels' titles.
//
// 💥 WAS MISSING, and it cost 245 phantom players. telly and ranked brand their
// titles with it — "Tekken 8 💥 DADDYKING (#1 Ranked Clive) Vs SHINE (…)" — and
// without it in this class the whole "Tekken 8 💥 DADDYKING" ran through as the
// handle. That minted `tekken-8-daddyking` beside the real `daddyking`, and 244
// more like it: `tekken-8-knee` (20 sides) next to `knee` (1,942),
// `tekken-8-qudans` (21) next to `qudans` (801). 623 sides across telly (160)
// and ranked (463), and 245 live /players/tekken-8-* pages.
//
// Found by the Replay Theater cross-check, which is exactly what a second
// witness is for: the catalogue said "Knee" where we said "Tekken 8 💥 Knee" on
// 150 of the sides, and nothing inside this pipeline had any reason to doubt a
// handle it had parsed cleanly. It is fixed here rather than in the cross-check
// because the phantom ids are wrong whether or not anyone else indexes the video
// — the remaining 473 sides are on VODs the catalogue has never seen.
const SEG_RE = /[▰🔥⚡•▶►|💥]+/u;

/**
 * A GAME MARKER LEADING THE HANDLE SLOT, where no segment delimiter separated
 * it. 31 of the 623 came in as "TEKKEN 8  RAIGEKI (#1 Ranked Lili) vs …" — the
 * brand and the handle divided by nothing but a double space, with one variant
 * using " - ". SEG_RE cannot reach those; this can.
 *
 * NARROW ON PURPOSE. It requires the "8", so the real handles this corpus
 * carries survive untouched: Tekken Master, TekkenCrashS2, Tekken2024,
 * TekkenDestroyer. Measured over every side in data/videos.json — 623 phantom
 * sides cleared, 0 legitimate handles altered.
 */
const LEAD_GAME_MARKER = /^\s*(?:TEKKEN\s*8|T8|鉄拳\s*8)\b[^A-Za-z0-9一-鿿]*\s+(?=\S)/iu;

function cleanHandle(raw: string): string | null {
  let t = raw.split(SEG_RE).pop() ?? '';
  t = t.split(/\s[-–—]\s/).pop() ?? '';
  t = t.replace(LEAD_GAME_MARKER, '');
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
/** Each intake's OWN dump, kept beside the pooled `raws` for the stale-raw
 *  guard. The guard is scoped per intake — a stale telly dump says nothing
 *  about highLevel — so pooling alone cannot drive it. */
const dumps = new Map<ChannelKey, RawVideoRecord[]>();
/** The index intake's dump, when this run has one. Kept OUT of `raws` because
 *  its records are not built by a title parse — see buildTheaterRecords. */
let theaterRaw: TheaterRawRecord[] = [];
/** Cron-fetched intakes with no usable dump on this run, so their committed
 *  records are carried instead of rebuilt. This USED to be every cron run,
 *  every time — raw/ is gitignored and the cron fetched nothing. Now it is the
 *  FALLBACK: the cron does fetch, and this is what happens on the mornings the
 *  catalogue is unreachable, unparseable, or hands back nothing. That last one
 *  is the ordinary case in this repo, whose tagged rows stop at 2025-03-16.
 *  Together those are the whole of "the cron never depends on the pull". */
const carriedWithFallback: ChannelKey[] = [];
for (const ch of CHANNELS) {
  const path = join(ROOT, 'raw', `${ch.id}.json`);
  let dump: RawVideoRecord[];
  try {
    dump = await readJson<RawVideoRecord[]>(path);
  } catch {
    // A CRON-FETCHED intake legitimately has no dump here. It is no longer the
    // normal state — the cron fetches now — but it is the designed failure
    // state, and the response is unchanged: carry its committed records.
    // Requiring the dump would break the daily build the first morning the
    // catalogue was down; parsing without it would delete every one of its
    // records. This branch is what keeps a bad day upstream costing that day's
    // new entries and nothing else.
    if (ch.cronFetchedWithCarry) {
      carriedWithFallback.push(ch.id);
      continue;
    }
    console.error(`✖ ${path} missing/unreadable — run \`npm run data:fetch\` first.`);
    process.exit(1);
  }
  if (ch.index) {
    // AN EMPTY DUMP IS A CARRY, NOT A REBUILD TO ZERO. `readJson` succeeds on a
    // present-but-empty file, so without this the empty case falls straight
    // through to a rebuild, produces 0 records, and trips the collapse guard at
    // 317 → 0 — a red cron for a reason nothing in the failure names.
    //
    // And here that is not a corner case: this catalogue's tagged Tekken rows
    // stop at 2025-03-16 while its feed's front is current, so a cursor run
    // reads ten pages of 2026 untagged entries and writes exactly this. An
    // empty dump is the EXPECTED shape of a successful morning, and the cursor
    // below still advances off it.
    if (dump.length === 0) {
      carriedWithFallback.push(ch.id);
      continue;
    }
    // Structured at source: handles, characters, event tag and a start offset
    // are separate fields, so there is no title to parse.
    //
    // AND EXEMPT FROM THE STALE-RAW GUARD, which is load-bearing rather than a
    // concession — the same call SF6 makes (its parse.ts:338-352). That guard
    // asks whether a dump could have produced the committed corpus; for an index
    // intake the answer is governed by a third party's catalogue, not by when we
    // last fetched. An event withdrawn from the catalogue would read as
    // staleness and refuse every run thereafter, which is how a guard becomes a
    // flag people learn to pass. Its protection is the count pin instead, which
    // is strictly stronger: the pin demands an exact number.
    theaterRaw = dump as TheaterRawRecord[];
    continue;
  }
  dumps.set(ch.id, dump);
  raws.push(...dump);
}
const overrides = await readJson<Record<string, VideoOverride>>(join(DATA, 'overrides.json')).catch(
  () => ({}) as Record<string, VideoOverride>,
);

/** The committed catalogue, read once. It is the baseline for the stale-raw
 *  guard, the source of the index intake's carry, and one arm of that intake's
 *  ignore-if-known set. Absent is a legitimate first run; anything
 *  else — a truncated file, a bad merge — must NOT be silently read as an empty
 *  corpus, because that would carry nothing and hand every guard a baseline of
 *  zero. */
const committedForKnown: MatchVideo[] = await readJson<MatchVideo[]>(join(DATA, 'videos.json'))
  .then((v) => {
    if (!Array.isArray(v)) throw new Error('data/videos.json is not an array');
    return v;
  })
  .catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [] as MatchVideo[];
    console.error(
      `✖ data/videos.json is unreadable (${e.message}) — refusing to treat it as empty.`,
    );
    process.exit(1);
  });

// ── stale-raw guard ──────────────────────────────────────────────────────────
// DATA-ONLY, per intake. The predicate and its refusal text live in
// scripts/freshness.ts so scripts/e2e.ts can drive them directly; the whole
// argument for the shape — and for why the old mtime arm had to go before the
// Replay Theater intake could join the cron — is in that file's header.
//
// The index intake is not checked here: it is exempted at the `ch.index` branch
// above and protected by its count pin instead.
if (!process.argv.includes('--allow-stale')) {
  for (const [key, dump] of dumps) {
    const ev = staleEvidence(key, dump, committedForKnown);
    if (ev) {
      console.error(formatStaleRefusal(key, ev));
      process.exit(1);
    }
  }
}

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

// HANDLE_ALIASES moved to scripts/players.ts, which is where the identity
// resolution that needs it lives. It sat here holding one entry and was
// consulted only by the review-queue prefill below — never by the id path,
// which is the one place a variant spelling actually mints a second page.

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
// ── the index intake: rebuild from a dump, or carry ─────────────────────────
//
// A THIRD CONSTRUCTION PATH, beside the title parse and the footage verdict.
// The catalogue arrives structured — handles, characters, event tag and offset
// are separate fields — so there is no title to parse. The title these records
// carry was SYNTHESIZED by the fetcher from those same fields.
//
// TRUST TIER. Third-party curation is weaker provenance than either of the
// other two paths, so it takes the STRICTER of their gates: characters resolve
// on an EXACT alias only — never through `matcher.one()`, whose job is to read
// prose — and an unresolved token is dropped to residue rather than guessed.
//
// CARRY vs REBUILD. When the pull produced no usable dump the committed records
// are CARRIED; when it produced one they are REBUILT and merged ADD-ONLY over
// the committed set. Both must publish identical bytes from identical inputs,
// which they do because applyOverrides below is the only curation step and it
// runs over the assembled array either way — and because a rebuild of an entry
// the catalogue still holds re-derives exactly the record already committed.
const theaterSkippedKnown: { videoId: string; tag: string; where: string }[] = [];
const theaterResidue: { id: string; raw: string }[] = [];

function buildTheaterRecords(ch: ChannelConfig, dump: TheaterRawRecord[]): MatchVideo[] {
  // ── ignore-if-known, and it runs FIRST ────────────────────────────────────
  // If this repo has already ruled on a video IN ANY CAPACITY, the catalogue
  // entry is ignored. Not merged, not preferred — ignored. The predicate is
  // known-ANYWHERE rather than merely in-records, because an id excluded as
  // wrong-game or dropped as a duplicate must not re-enter through a side door;
  // that verdict is the whole point of overrides.json.
  //
  // It keys on the VIDEO id, not the record id. A composite id can never equal
  // an 11-character YouTube id, so comparing record ids would match nothing and
  // the rule would silently never fire.
  //
  // `raws` is the widest arm and the one that matters: it holds every upload
  // these channels ever made, pre-gate, so a longform VOD this repo fetched and
  // could not parse still counts as ruled-on. Measured cost on the first
  // ingest: 0 of 317 — the catalogue's Tekken VODs belong to eleven organiser
  // channels none of which this repo tracks. That is a fact about today's data,
  // not a guarantee, which is why it is reported rather than assumed.
  const knownAnywhere = new Map<string, string>();
  const note = (id: string, where: string) => {
    if (!knownAnywhere.has(id)) knownAnywhere.set(id, where);
  };
  for (const r of raws) note(r.id, `raw/${r.channel}.json`);
  for (const v of committedForKnown) note(v.id, `videos.json (${v.intake})`);
  for (const [id, ov] of Object.entries(overrides)) {
    note(id, ov.exclude === true ? 'overrides.json (excluded)' : 'overrides.json');
  }

  const kept: TheaterRawRecord[] = [];
  for (const r of dump) {
    const where = knownAnywhere.get(r.videoId);
    if (where) theaterSkippedKnown.push({ videoId: r.videoId, tag: r.tag, where });
    else kept.push(r);
  }

  // ── duplicate ids across intakes ──────────────────────────────────────────
  // Structurally impossible today — every index id contains "@" and no other
  // intake's does — which is exactly why it is worth asserting. Ids are the
  // primary key of videos.json and overrides.json, so a collision does not
  // error downstream: one record silently replaces the other.
  const byId = new Map<string, string>();
  for (const r of raws) byId.set(r.id, `raw/${r.channel}.json`);
  for (const v of committedForKnown) if (v.intake !== ch.id) byId.set(v.id, `videos.json`);
  const collisions: string[] = [];
  const seenHere = new Set<string>();
  for (const r of kept) {
    const other = byId.get(r.id);
    if (other) collisions.push(`  ${r.id}: ${ch.id} vs ${other}`);
    if (seenHere.has(r.id)) collisions.push(`  ${r.id}: ${ch.id} vs ${ch.id}`);
    seenHere.add(r.id);
  }
  if (collisions.length > 0) {
    console.error(
      [`✖ ${collisions.length} record id(s) claimed by two intakes — nothing written:`]
        .concat(collisions.slice(0, 20))
        .join('\n'),
    );
    process.exit(1);
  }

  // Name and every declared alias, lowercased. The character ID is deliberately
  // not a key: ids are ours and the catalogue writes display names.
  const byAlias = new Map<string, string>();
  for (const c of characters) {
    byAlias.set(c.name.trim().toLowerCase(), c.id);
    for (const a of (c.extra?.aliases as string[] | undefined) ?? []) {
      byAlias.set(a.trim().toLowerCase(), c.id);
    }
  }

  const out: MatchVideo[] = [];
  for (const r of kept) {
    // The same pre-launch floor every fetched channel gets. An index intake
    // never enters the title-parse path, so without this it would have no floor
    // at all rather than the global one.
    if (r.publishedAt.slice(0, 10) < S1_START) continue;

    const sides: MatchSide[] = [];
    for (let i = 0; i < 2; i++) {
      // Sponsor prefix STRIPPED, never split: "|" is not a duo delimiter here.
      // Then the repo's own org-tag rule, so "ATL Nyanko" and "OEG | Slate"
      // reduce the same way title-parsed handles do.
      const handle = stripOrgPrefix(stripTheaterSponsor(r.players[i] ?? ''));
      const ids: string[] = [];
      const unresolved: string[] = [];
      for (const tok of r.characters[i] ?? []) {
        const id = byAlias.get(tok.trim().toLowerCase());
        if (id === undefined) unresolved.push(tok);
        else if (!ids.includes(id)) ids.push(id);
      }
      if (unresolved.length) theaterResidue.push({ id: r.id, raw: unresolved.join(', ') });
      sides.push({ player: slug(handle), handle, characters: ids });
    }

    // A side with no character is the one state emit hard-fails on. Catch it
    // here so it reads as a countable miss on this intake rather than a crash
    // three stages later. Same for a handle that slugs to nothing.
    if (sides.some((s) => s.characters.length === 0 || !s.handle || !s.player)) continue;

    out.push({
      id: r.id,
      channel: ch.source,
      intake: ch.id,
      title: r.title,
      publishedAt: r.publishedAt,
      durationSec: r.durationSec,
      season: resolveSeason(r.publishedAt.slice(0, 10), null),
      patchVersion: patchTable.patchForDate(r.publishedAt)?.version ?? null,
      videoId: r.videoId,
      startSeconds: r.startSeconds,
      sides: [sides[0]!, sides[1]!] as [MatchSide, MatchSide],
    });
  }
  return out;
}

/**
 * THE INDEX INTAKE VOTES ON HANDLE CASING FROM THE ASSEMBLED RECORD, not from
 * the catalogue string, and the distinction is what makes the carry sound.
 *
 * A vote cast inside the builder cannot be re-cast on a run that has no dump,
 * so an intake that voted there would resolve players differently depending on
 * whether raw/ happened to be present — measured: four players, twenty records.
 * Casting it here, from `s.handle`, is symmetric: a rebuild votes the
 * catalogue's spelling, a carry votes the spelling that same catalogue's vote
 * elected last time, and re-electing a winner is a fixpoint.
 *
 * Not voting at all was tried and is worse. resolvePlayers merges spelling
 * variants through this tally, so an intake with no votes cannot merge its own:
 * the catalogue spells one Claudio player both "Divine Exorcist4" and
 * "DivineExorcist4", whose alphanumerics are identical but whose slugs are not,
 * and with no votes they became two player pages — caught by the undeclared
 * collision gate, which is exactly what that gate is for.
 */
const voteIndexHandles = (records: MatchVideo[]) => {
  for (const v of records) for (const s of v.sides) noteHandle(s.player, s.handle, 1);
};

/**
 * ADD-ONLY, and this is where that rule is mechanical rather than aspirational.
 *
 * A rebuild used to REPLACE the intake wholesale with whatever the dump could
 * produce. That was safe while the dump was always the whole catalogue, fetched
 * by a human who would notice. It is not safe now, for two independent reasons:
 *
 *  · THE DUMP IS USUALLY A DELTA. The cron runs the cursor, which reads the
 *    front of the feed and stops — so theaterRaw holds the few entries those
 *    pages carried, not 317. Replacing on that would delete the intake daily.
 *  · A VOD GOING PRIVATE DELETES EVERY SEGMENT CUT FROM IT. Measured on the
 *    committed intake: the largest single source VOD holds 13 of the 317
 *    records, 4.1%. The collapse guard fires on >20 records AND >10%, so 13
 *    fails BOTH arms — that loss passes every gate in silence, and the pin
 *    would then be rewritten downward to match it.
 *
 * So: BUILT WINS WHERE THE DUMP SPEAKS, COMMITTED SURVIVES WHERE IT DOES NOT.
 * An entry still in the catalogue is re-derived exactly as before, which is what
 * keeps a carry and a rebuild byte-identical; an id the dump does not mention is
 * carried untouched rather than dropped.
 *
 * The survivors are COUNTED, not silent — but what the count MEANS depends on
 * the pull's mode, so report.md only calls them "no longer in the catalogue"
 * after a full sweep. On a cursor run "absent from the dump" is the normal state
 * of every record older than the pages read, which here is all 317 of them.
 */
/** intake → committed records the dump did not mention this run. */
const theaterSurvivors = new Map<ChannelKey, MatchVideo[]>();
for (const ch of CHANNELS.filter((c) => c.cronFetchedWithCarry)) {
  const mine = committedForKnown.filter((v) => v.intake === ch.id);
  let rs: MatchVideo[];
  if (carriedWithFallback.includes(ch.id)) {
    // Carried, not rebuilt. The records go into the same array by the same
    // route, so the collapse guard below sees 317 → 317 rather than 317 → 0 —
    // which is why this repo needs NO carry exclusion in that guard, unlike the
    // sibling it is ported from. It tallies PARSED against COMMITTED, and a
    // carried record is parsed for that purpose.
    rs = mine;
    theaterSurvivors.set(ch.id, []);
  } else {
    const built = buildTheaterRecords(ch, theaterRaw);
    const builtIds = new Set(built.map((v) => v.id));
    const survivors = mine.filter((v) => !builtIds.has(v.id));
    theaterSurvivors.set(ch.id, survivors);
    rs = [...built, ...survivors];
  }
  voteIndexHandles(rs);
  videos.push(...rs);
}

// ── the carry pin (data/source-pins.json) ───────────────────────────────────
// data/videos.json is both the source and the target of the carry, so one bad
// run would poison the next run's baseline permanently and silently. Asserted
// on a carry, written on a rebuild: a rebuild has the dump in front of it and
// is the authority on the count; a carry has only yesterday's file.
//
// The assertion is unconditional for a carried intake — NOT guarded on
// "carried something", which would make total loss the one case that passes.
// It is made below, once `records` exists: the pin counts PUBLISHED records.
const sourcePins: SourcePins = await readJson<SourcePins>(join(DATA, 'source-pins.json')).catch(
  () => ({}) as SourcePins,
);
/** What the pull said about ITSELF, written by scripts/fetch-theater.ts beside
 *  the dump. Absent means NO PULL RAN — a different thing from a pull that found
 *  nothing, and report.md says which. The collapsed entries are gone from the
 *  dump by the time parse sees it, so this is the only way that number can be
 *  stated rather than absorbed. */
const theaterStats = await readJson<{
  /** 'cursor' = this dump is a DELTA off the front of the feed; 'full' = it
   *  claims to be the whole catalogue. Only a full sweep can say that a
   *  committed record is gone from upstream. */
  mode?: 'cursor' | 'full';
  maxEntryId?: number;
  pagesRead?: number;
  hitBound?: boolean;
  tagged?: number;
  collapsed?: number;
  collapsedTags?: Record<string, number>;
  unresolvableVods?: number;
}>(join(ROOT, 'raw', '.replayTheater.stats.json')).catch(() => null);
/** The committed cursor, read here and rewritten below. */
const theaterCursor = await readJson<Record<string, number>>(
  join(DATA, 'theater-cursor.json'),
).catch(() => ({}) as Record<string, number>);

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

// ── the carry pin, asserted ─────────────────────────────────────────────────
// COUNTED AFTER CURATION, on both sides. The re-pin below and the
// data/videos.json write both count `records`, so the pin means "published
// count" everywhere — and this assertion used to count `videos`, the
// pre-override array. The two agree only while no override touches a carried
// intake: the first exclusion on one of the 317 index records would fail this
// check on every run thereafter with nothing actually wrong, and a carry that
// lost a record while an override added one back would pass. sf6 and tokon both
// count it after curation.
for (const key of carriedWithFallback) {
  const got = records.filter((v) => v.intake === key).length;
  const want = sourcePins[key];
  if (want === undefined) {
    console.error(
      `✖ ${key} carried ${got} record(s) but data/source-pins.json has no pin for it.\n` +
        `  "No expectation" is the exact state the pin exists to prevent.\n` +
        `  Run \`npm run data:theater -- --full\` then \`npm run data:parse\` to rebuild and pin.\n` +
        `  --full, NOT the bare cursor: the shallowest tagged entry in this catalogue\n` +
        `  sits on page 97 of 230 and the cursor reads at most 10, so a cursor pull\n` +
        `  writes an empty dump, parse correctly reads that as another CARRY, and the\n` +
        `  remedy loops on this same refusal.`,
    );
    process.exit(1);
  }
  if (got !== want) {
    console.error(
      `✖ source pin mismatch on ${key}: carried ${got}, pinned ${want}.\n` +
        `  data/videos.json is both the source and the target of this carry, so drift\n` +
        `  compounds: the next run would treat ${got} as the new baseline.\n` +
        `  If deliberate, rebuild with \`npm run data:theater -- --full\` (a cursor pull\n` +
        `  cannot reach the tagged entries — they start on page 97 of 230 and the cursor\n` +
        `  reads at most 10 — so it writes an empty dump and parse carries again), then\n` +
        `  \`npm run data:parse\` and commit the new pin.`,
    );
    process.exit(1);
  }
}

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

/**
 * ONE PLAYER, ONE PAGE — run before the registry is built, over the
 * post-override records.
 *
 * The loop this replaces picked the best casing PER ID, which is right about
 * casing and blind to the split it was choosing between: two spellings of one
 * player have two ids, so it never compared them. "X c c" (155 records) and
 * "Xcc" (83) were two pages and each looked correct from the inside.
 */
const mergeReport = resolvePlayers(records, casing, slug);

// registry from the post-override records; best casing per id
const playerIds = new Map<string, string>(); // id → best handle
for (const v of records) {
  for (const s of v.sides) if (!playerIds.has(s.player)) playerIds.set(s.player, s.handle);
}
const seen = new Set<string>();
for (const v of records) for (const s of v.sides) seen.add(s.player);
const players: PlayerRecord[] = [...seen].sort().map((id) => ({
  id,
  handle: playerIds.get(id) ?? id,
  ...(FEATURED.has(id) ? { featured: true } : {}),
}));
const collisions = undeclaredCollisions(players);

// ── the review queue ─────────────────────────────────────────────────────────
// Footage-completion items, now that canonical spellings exist. Pre-filling the
// handle with the corpus's own spelling is what stops a verdict minting a
// second player page for someone already in players.json — the review POST
// slugs whatever the form contains and does not run this file's identity merge.
const reviewQueue: ReviewQueueItem[] = [];
const footagePendingIds = new Set(footagePending.map((p) => p.raw.id));
for (const { raw, handles } of footagePending) {
  const canonical = (h: string): string => {
    const aliased = HANDLE_ALIASES.get(idKey(h)) ?? h;
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
//
// That parenthesis was FALSE from the day it was written until 2026-08-31: the
// workflow's git add did not name this file, so the cron regenerated it and
// discarded the result every morning. It is named now, and scripts/e2e.ts
// asserts the staged list by name so the comment cannot go stale again.
await writeFile(
  join(DATA, 'review-queue.json'),
  JSON.stringify(reviewQueue, null, 2) + '\n',
  'utf8',
);
/**
 * THE RETIRED-ID LEDGER — append-only, and that is the whole point.
 *
 * A merged spelling's id is only observable at the moment of the merge: once
 * data/videos.json is canonicalised, the old spelling is gone and nothing can
 * rediscover it, so recomputing this set from committed data yields nothing. It
 * also decays — when the last record carrying an old spelling leaves the corpus,
 * a recomputed set would silently drop that redirect and the indexed URL would
 * 404 again with no diff to explain it.
 *
 * Feeds `npm run data:redirects`. A row leaves it only by hand.
 */
const priorRedirects: Record<string, string> = await readJsonSafe(
  join(DATA, 'player-redirects.json'),
);
const proposedRedirects: Record<string, string> = { ...priorRedirects };
for (const [canonical, absorbed] of mergeReport.merged) {
  for (const dead of absorbed) proposedRedirects[dead] = canonical;
}
const playerIdSet = new Set(players.map((p) => p.id));
const redirectLedger = Object.fromEntries(
  Object.entries(proposedRedirects)
    .filter(([from, to]) => from !== to && playerIdSet.has(to))
    .sort(([a], [b]) => a.localeCompare(b)),
);

// ── the carry pin, rewritten by a rebuild — AND IT ONLY GROWS ───────────────
// Re-pin every cron-fetched intake REBUILT this run, from the final count —
// exclusions and all — so the number the next carrying run checks against is
// the number actually published.
//
// THE ONLY-GROWS REFUSAL IS NEW, and it replaces a guarantee this move removes
// rather than adding a belt on top of one. Until today every cron run was a
// carry, so the pin was ASSERTED daily at exact equality — the strongest check
// this intake had, and the one the controls on the ingest were run against.
// From today a run that pulled anything rebuilds, and a rebuilding run does not
// assert the pin at all: it overwrites it. The only check left would be the
// collapse guard, and the collapse guard is measurably blind to the loss that
// actually happens here — the largest single source VOD holds 13 of the 317
// records (4.1%), which fails the >20-record arm and the >10% arm both, so
// losing that whole VOD passes in silence.
//
// A pin that can only rise turns "records left quietly" into a refusal. When the
// drop is real — an event genuinely withdrawn — the operator says so once, with
// --allow-shrink, and the smaller number is committed deliberately.
const rebuiltThisRun = CHANNELS.filter(
  (c) => c.cronFetchedWithCarry && !carriedWithFallback.includes(c.id),
);
if (rebuiltThisRun.length > 0) {
  const next: SourcePins = { ...sourcePins };
  for (const ch of rebuiltThisRun) {
    const got = records.filter((v) => v.intake === ch.id).length;
    const was = sourcePins[ch.id] ?? 0;
    if (got < was && !process.argv.includes('--allow-shrink')) {
      console.error(
        [
          `✖ ${ch.id} would re-pin DOWNWARD: ${was} → ${got}.`,
          ``,
          `  This intake is add-only. A committed record is carried whether or not the`,
          `  catalogue still lists it, so the published count cannot fall on its own —`,
          `  which means ${was - got} record(s) were dropped by something in this run, and`,
          `  the collapse guard is not sensitive enough to have caught it (the largest`,
          `  single source VOD here is 13 records, 4.1%, and the guard needs >20 AND >10%).`,
          ``,
          `  Stopping here: data/videos.json, the pin and the cursor are all untouched,`,
          `  so the published corpus is exactly what it was. If the drop is genuine`,
          `  and deliberate:  npm run data:parse -- --allow-shrink`,
        ].join('\n'),
      );
      process.exit(1);
    }
    next[ch.id] = got;
  }
  const ordered = Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => a.localeCompare(b)),
  ) as SourcePins;
  await writeFile(join(DATA, 'source-pins.json'), JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}

// ── the cursor (data/theater-cursor.json) ───────────────────────────────────
// One integer per index intake: the highest catalogue entry id ever seen. It is
// what lets tomorrow's fetch read two pages instead of 230, so it has to survive
// into the repository — raw/ is gitignored and CI starts from a fresh checkout
// with no memory but data/.
//
// CONTENT ONLY, no timestamp. report.md's "_Generated_" line already costs the
// cron a suppression rule; a second file that changed every morning would defeat
// that rule from the other side and produce a commit — and a deploy — on days
// when nothing happened.
//
// ONLY GROWS, for the same reason the pin does, and here it matters more: a
// cursor that moved BACKWARD would silently re-admit entries as "new", and one
// that moved back to 0 would turn every cron run into a ten-page sweep that
// never goes quiet.
//
// KEYED ON THE PULL, NOT ON THE REBUILD, and that distinction is the whole
// reason this repo can use a cursor at all. A pull that returns no TAGGED
// entries writes an empty dump, which parse correctly treats as a carry, so
// `rebuiltThisRun` is empty. Driving the cursor off that list would mean the
// cursor advanced in memory and was never persisted — and in THIS repo that is
// not an edge case but every single morning, because the catalogue's tagged
// Tekken rows stop at 2025-03-16 while its feed's front is current. The cursor
// would never move, tomorrow would re-read the same ten pages forever, and the
// mechanism would look like it worked. The pull happening is what moves the
// cursor; whether it produced records is a different question.
// WHETHER THE CURSOR MOVED is a fact the report states, so it is measured
// rather than assumed: on 2026-09-02 2XKO's cursor stayed at 488405 while its
// report said it "still advanced".
const cursorMoved =
  !!theaterStats &&
  typeof theaterStats.maxEntryId === 'number' &&
  theaterStats.maxEntryId > (theaterCursor.replayTheater ?? 0);
if (theaterStats && typeof theaterStats.maxEntryId === 'number') {
  const nextCursor: Record<string, number> = { ...theaterCursor };
  for (const ch of CHANNELS.filter((c) => c.index && c.cronFetchedWithCarry)) {
    nextCursor[ch.id] = Math.max(theaterCursor[ch.id] ?? 0, theaterStats.maxEntryId);
  }
  const ordered = Object.fromEntries(
    Object.entries(nextCursor).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(
    join(DATA, 'theater-cursor.json'),
    JSON.stringify(ordered, null, 2) + '\n',
    'utf8',
  );
}

await writeFile(join(DATA, 'videos.json'), JSON.stringify(records, null, 1) + '\n', 'utf8');
await writeFile(join(DATA, 'players.json'), JSON.stringify(players, null, 2) + '\n', 'utf8');
await writeFile(
  join(DATA, 'player-redirects.json'),
  JSON.stringify(redirectLedger, null, 2) + '\n',
  'utf8',
);
await writeFile(
  join(DATA, 'seasonBoundaries.json'),
  JSON.stringify(SEASONS, null, 2) + '\n',
  'utf8',
);

// ── the second witness (scripts/crosscheck.ts) ──────────────────────────────
// Reads raw/replayTheater.witness.json — every entry the pull saw, INCLUDING
// the untagged online rows the intake deliberately ignores — and compares the
// catalogue's claim to ours on the videos both sides hold. It writes no field
// and gates nothing.
//
// ABSENT ON A CARRYING RUN, and that is not an error any more than the missing
// dump beside it is: no pull, no witness, no block in report.md. Same silence
// the carry note above takes.
//
// THE STRIPPER IS THE INTAKE'S OWN, both halves. buildTheaterRecords cleans a
// catalogue handle with stripTheaterSponsor THEN stripOrgPrefix, so the witness
// has to do the same or the catalogue's "Zeta Keisuke" and our "Keisuke" read
// as two people — measured 2026-08-31: 231 of 396 missed sides were exactly
// that, and passing both halves takes the player agreement from 94.62% to
// 97.65% without a single fuzzy comparison.
//
// WHY THE DISAGREEMENTS DO NOT GO IN data/review-queue.json, which is where the
// plan for this work said to put them: in this repo that queue means WITHHELD.
// scripts/e2e.ts asserts `allVideos.every((v) => !queuedIds.has(v.id))` —
// "pending review items never reach videos.json" — and its sibling for
// replays.json. A cross-check disagreement is a record we have ALREADY
// published from a tracked channel and are not proposing to unpublish. Filing
// it there would either break that gate or silently pull a good record off the
// site over a third party's say-so, and the catalogue does not outrank a
// confident parse. So it gets its own artifact: published, contested, both
// claims recorded.
//
// There is no /dev form for these yet. The report block below and the committed
// artifact are the working surface; with five rows on the 2026-08-31 pull that
// is the right amount of machinery, and the count is what would justify more.
const witness = await readJson<WitnessFile>(join(ROOT, 'raw', 'replayTheater.witness.json')).catch(
  () => null,
);
// The intake's own exact-alias table, rebuilt here because buildTheaterRecords
// builds it inside itself and a carrying run never calls it. Name and every
// declared alias, lowercased; the character ID is deliberately not a key,
// because ids are ours and the catalogue writes display names.
const byAliasForWitness = new Map<string, string>();
for (const c of characters) {
  byAliasForWitness.set(c.name.trim().toLowerCase(), c.id);
  for (const a of (c.extra?.aliases as string[] | undefined) ?? []) {
    byAliasForWitness.set(a.trim().toLowerCase(), c.id);
  }
}
// THE ARTIFACT CARRIES THE BLIND SPOTS AND THE MEASUREMENT AS WELL AS THE ROWS.
// The blind spots came first and are this repo's own: this is the only game
// where the catalogue has a vocabulary GAP rather than merely a column ceiling —
// it has no word for Armor King, writing "King" on 332 of the 333 sides where we
// say `armor_king` — and a gap has to be remembered between runs. The derivation
// needs ten sides of evidence before it will believe one, which a two-page
// cursor morning cannot supply, so without this the daily run reports seven
// correct Armor King records as contested and the artifact stops being worth
// reading. See crosscheck.ts's `carriedBlindSpots`.
//
// The measurement is here for the same reason one step further out: report.md
// renders from what is COMMITTED, so its cross-check block is byte-identical
// between sweeps instead of moving with whatever window this morning's cursor
// happened to read. See crosscheck.ts's WitnessArtifact.
const disagreementsPath = join(DATA, 'theater-disagreements.json');
let witnessArtifact = await readJson<WitnessArtifact>(disagreementsPath).catch(
  () => ({ blindSpots: [], disagreements: [] }) as WitnessArtifact,
);
const witnessResult = witness
  ? crossCheck(
      witness,
      records,
      byAliasForWitness,
      resolveKey,
      (h) => stripOrgPrefix(stripTheaterSponsor(h)),
      4,
      witnessArtifact.blindSpots ?? [],
    )
  : null;
// ONLY A FULL SWEEP WRITES, and the measurement is written with the rows. A
// cursor pull sees whatever is at the front of the feed this morning — a couple
// of hundred catalogue rows — so its reading is a different WINDOW, not a
// different corpus. Letting it write threw the last sweep's rows away on the
// first quiet morning and flapped them back on the next one that happened to
// contain a disagreement, and rendering its numbers into report.md made that
// file differ every single day whether or not a record had. See
// crosscheck.ts's WitnessArtifact.
if (witnessResult && witness?.mode === 'full') {
  witnessArtifact = {
    // The witness's own high-water id, not the stats file's: this measurement
    // was taken from that file and names the sweep that produced it. The stats
    // file stands in when a hand-placed witness predates it.
    measured: {
      atEntryId: witness.maxEntryId ?? theaterStats?.maxEntryId ?? 0,
      compared: witnessResult.compared,
      unmatched: witnessResult.unmatched,
      segmented: witnessResult.segmented,
      players: witnessResult.players,
      characters: witnessResult.characters,
    },
    blindSpots: witnessResult.blindSpots,
    disagreements: witnessResult.disagreements,
  };
  await writeFile(disagreementsPath, JSON.stringify(witnessArtifact, null, 2) + '\n', 'utf8');
} else if (!existsSync(disagreementsPath)) {
  // A RUN THAT DID NOT SWEEP DOES NOT REWRITE THIS FILE — a carrying run has no
  // witness at all, and a cursor run has only a window — and overwriting it with
  // an empty artifact would erase the record of what the last real sweep
  // contested. But the cron NAMES this path in its `git add`, and `git add` on a
  // path that does not exist fails under `set -e`, which aborts the commit step
  // and produces no commit at all. So: seeded when absent, never touched when
  // present. The empty artifact is the honest state of a repository that has
  // never run a cross-check.
  await writeFile(
    disagreementsPath,
    JSON.stringify({ blindSpots: [], disagreements: [] }, null, 2) + '\n',
    'utf8',
  );
}
// A CURSOR MORNING'S READING GOES TO THE CONSOLE, where it is useful and costs
// nothing. It is a real measurement of a real window; it is just not a
// measurement of the corpus, so it is not committed.
if (witnessResult && witness?.mode !== 'full') {
  const c = witnessResult.characters;
  console.log(
    `  cross-check (cursor window, not committed): ${witnessResult.compared} record(s), ` +
      `${witnessResult.players.both} both-handles, ${c.agree}/${c.sides} character sides agree, ` +
      `${witnessResult.disagreements.length} disagreement(s)`,
  );
}

// ── report ───────────────────────────────────────────────────────────────────
// Records carry the SOURCE, so coverage is counted back through the intake
// channel (sources may aggregate several channels).
const byChannel = (id: string) => ({
  // An index intake is read outside `raws`, so its dump has to be counted
  // explicitly or the row reads 0 uploads / 0 parsed on the very run that
  // rebuilt it. `parsed` reads the record's own `intake` — this used to look
  // the id up in a map built from `raws`, which knows nothing about a composite
  // id and so scored every segment record as belonging to no channel.
  raw: id === 'replayTheater' ? theaterRaw.length : raws.filter((r) => r.channel === id).length,
  parsed: records.filter((v) => v.intake === id).length,
  missed: reportedMisses.filter((m) => m.channel === id),
});
/** Records that came from an INDEX intake rather than from a title parse.
 *  Named in the headline separately because `raws` deliberately excludes the
 *  index dump — see there. */
const indexCount = records.filter((v) => CHANNELS.some((c) => c.index && c.id === v.intake)).length;
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
  // THE THREE NUMBERS HAVE TO BE ABOUT THE SAME THING. `raws` excludes the index
  // dump by construction (it is read outside `raws`, and it holds catalogue rows
  // rather than uploads), and the index source is not a fetched channel — so
  // counting it in the channel total said 317 records came from uploads that
  // were never counted, across a channel that is never fetched. Both are named.
  `**${records.length} matches** parsed from ${raws.length} uploads across ` +
    `${FETCHED_CHANNELS.length} channels` +
    (indexCount > 0 ? `, plus ${indexCount} from 1 index` : '') +
    ` · ${players.length} players · ranked sides ${rankSides}/${records.length * 2} ` +
    `(${((rankSides / (records.length * 2)) * 100).toFixed(1)}%)`,
  '',
  '| channel | source | uploads | parsed | coverage |',
  '| --- | --- | ---: | ---: | ---: |',
  ...CHANNELS.map((ch) => {
    const s = byChannel(ch.id);
    // A CARRIED intake has no uploads at all this run, by design. A bare
    // "0 | 317 | 0.0%" row would read as a channel that died.
    const carried = carriedWithFallback.includes(ch.id);
    const mark = ch.index ? (carried ? ' _(carried)_' : ' _(index)_') : '';
    // AND A COVERAGE SHARE IS ONLY MEANINGFUL WHEN `parsed` CAME OUT OF
    // `uploads`. On a cursor run the index dump is a delta of a few entries
    // while `parsed` counts the whole merged intake, so the division reads
    // several hundred per cent — a number that is not so much wrong as
    // meaningless. Both cells are withheld rather than dressed up: the delta
    // size is this morning's window, and a window number in report.md makes the
    // file differ on days when nothing changed. (tokon's guard, ported.)
    const windowOnly = ch.index && !carried && theaterStats?.mode === 'cursor';
    return carried || windowOnly
      ? `| ${ch.id}${mark} | ${ch.source} | — | ${s.parsed} | — |`
      : `| ${ch.id}${mark} | ${ch.source} | ${s.raw} | ${s.parsed} | ${((s.parsed / Math.max(1, s.raw)) * 100).toFixed(1)}% |`;
  }),
  '',
  ...(CHANNELS.some((c) => c.cronFetchedWithCarry)
    ? [
        '### Index intakes',
        '',
        'Fetched by the daily cron since 2026-09-02, and ADD-ONLY: a committed record is',
        'carried whether or not the catalogue still lists it, so this count can only rise.',
        'The cron does not depend on the pull succeeding — on any failure there is no dump,',
        'the committed records are carried, and the run stays green.',
        '',
        '| intake | records | pin | this run | pages | new | not in this pull |',
        '| --- | ---: | ---: | --- | ---: | ---: | ---: |',
        ...CHANNELS.filter((c) => c.cronFetchedWithCarry).map((ch) => {
          const n = records.filter((v) => v.intake === ch.id).length;
          const carried = carriedWithFallback.includes(ch.id);
          const mode = carried
            ? theaterStats
              ? 'carried (pull found no new tournament entries)'
              : 'carried (no pull this run)'
            : // No stats file beside a dump means no pull wrote that dump — a
              // hand-placed or leftover raw/replayTheater.json. It is rebuilt
              // from all the same, but nothing here can say WHICH catalogue it
              // represents, and the cursor below does not move on it either.
              !theaterStats
              ? 'rebuilt from a dump with no pull behind it'
              : theaterStats.mode === 'cursor'
                ? // NO PER-RUN DETAIL IN THE MODE STRING. `hitBound` used to be
                  // appended here, which made this cell — and therefore
                  // report.md — differ on the mornings it fired and not on the
                  // others. It is a real event and it is reported below, as its
                  // own conditional line.
                  'rebuilt from a cursor delta'
                : 'rebuilt from a full sweep';
          // On a rebuild the pin was just rewritten from this same count, so
          // read the count rather than the stale in-memory value we loaded
          // before writing it.
          const pin = carried ? (sourcePins[ch.id] ?? '—') : n;
          const survivors = theaterSurvivors.get(ch.id) ?? [];
          const built = n - survivors.length;
          // WHAT "not in this pull" MEANS DEPENDS ON THE MODE, and conflating
          // the two would be the most misleading number on this page. After a
          // FULL sweep it is "committed records no longer in the catalogue" —
          // the add-only rule's whole visible output. After a CURSOR run it is
          // every record older than the pages read, which in this repo is all
          // 317 of them, and it means nothing. So the full number is reported
          // and the cursor number is withheld rather than dressed up.
          const gone = carried || theaterStats?.mode !== 'full' ? '—' : String(survivors.length);
          // THE PER-RUN COLUMNS ARE WITHHELD ON A CURSOR MORNING, for the same
          // reason the cross-check block is rendered from the committed
          // artifact: `pages` and `new` describe this morning's WINDOW, not the
          // corpus, so printing them made report.md differ every day whether or
          // not a record had — which retires the cron's no-change-no-commit rule
          // through a side door and deploys the site daily forever.
          const swept = !carried && theaterStats?.mode === 'full';
          return `| \`${ch.id}\` | ${n} | ${pin} | ${mode} | ${swept ? (theaterStats?.pagesRead ?? '—') : '—'} | ${swept ? built : '—'} | ${gone} |`;
        }),
        '',
        // NOT PER-RUN NOISE: absent on every ordinary morning, present only on
        // one where the cursor could not go quiet inside its page bound, which
        // means entries may be unreached. That is a real event and belongs in
        // the commit, the same way an ACTION REQUIRED block does — the guard's
        // rule is that a diff which is ONLY the timestamp is not a change, not
        // that report.md may never change.
        ...(theaterStats?.hitBound
          ? [
              '_⚠ The cursor hit its page bound this run — entries may be unreached._',
              '_Nothing is lost (the intake is add-only); `npm run data:theater -- --full` reconciles._',
              '',
            ]
          : []),
        // A CARRY measures none of what follows — the dump it would have
        // measured is absent by design. Saying so beats printing 0, which reads
        // as "checked, found nothing" when the truth is "not checked this run".
        ...(carriedWithFallback.includes('replayTheater')
          ? theaterStats
            ? [
                '_The pull ran and found no new tournament entries, so the committed catalogue_',
                "_was carried unchanged and this pull's intake counts were not measured._",
                ...(cursorMoved
                  ? [
                      '_The cursor still advanced: a quiet day is the ordinary case here, not a_',
                      "_failed one — the catalogue's tagged Tekken rows stop at 2025-03-16._",
                    ]
                  : [
                      '_The cursor did not move: the catalogue has taken no new Tekken entry since_',
                      '_the last pull — quieter still, and equally ordinary. Its tagged Tekken rows_',
                      '_stop at 2025-03-16._',
                    ]),
                '',
              ]
            : [
                '_No pull produced a dump this run, so the committed catalogue was carried and_',
                '_the counts below were not measured. That is the designed fallback, not a_',
                '_failure of this run: `npm run data:theater` refreshes them._',
                '',
              ]
          : [
              // OF THE PULL, NOT OF THE PUBLISHED CATALOGUE. The denominator was
              // the record count, which on an add-only intake includes every
              // survivor carried from earlier pulls — so the ratio compared
              // this run's skips against a corpus this run never read, and it
              // shrank as the intake grew. `theaterRaw` is the dump the skips
              // were taken out of — every one of them is a row of it — which is
              // what 2xko already uses.
              theaterSkippedKnown.length > 0
                ? `Entries **skipped as already-known**: **${theaterSkippedKnown.length}** of ${theaterRaw.length} in this pull. An id this repo has already ruled on, in any capacity, does not re-enter through a side door.`
                : `_Entries skipped as already-known: **0** of ${theaterRaw.length} in this pull — none was a video this repo has already fetched, published or ruled on. A statement about this pull's tagged rows, not the catalogue: the cross-check below measures the catalogue-wide overlap._`,
              '',
              // STATED, NEVER ABSORBED. The collapsed rows are gone from the
              // dump by the time this file is written, so a collapse that is
              // not reported here is indistinguishable from a parser that lost
              // records. Nothing has collapsed in this catalogue yet; the
              // sibling SF6 one carries 35.
              ...(theaterStats?.collapsed
                ? [
                    `Entries **collapsed as double-submitted**: **${theaterStats.collapsed}** of ${theaterStats.tagged ?? '?'} tagged — ${Object.entries(
                      theaterStats.collapsedTags ?? {},
                    )
                      .sort((a, b) => b[1] - a[1])
                      .map(([pair, k]) => `${k}× \`${pair}\``)
                      .join(
                        ', ',
                      )}. The same match submitted twice under two tag spellings; one copy kept, chosen on the tag so the survivor does not depend on submission order.`,
                    '',
                  ]
                : []),
              ...(theaterResidue.length > 0
                ? [
                    `⚠ **${theaterResidue.length}** side(s) carried a character string that resolves to no roster id. Dropped to residue, never guessed:`,
                    '',
                    ...theaterResidue.slice(0, 20).map((r) => `- \`${r.id}\` — ${r.raw}`),
                    '',
                  ]
                : []),
            ]),
      ]
    : []),
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
  `Player identity: ${mergeReport.merged.size} identity(s) resolved from more than one spelling` +
    `${collisions.length ? ` · ⚠ ${collisions.length} UNDECLARED collision(s)` : ''}`,
  '',
  ...(mergeReport.merged.size
    ? [
        'Retired ids are 301-redirected from vercel.json — run `npm run data:redirects`',
        'after changing scripts/players.ts, or the old URLs 404.',
        '',
        ...[...mergeReport.merged]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .slice(0, 40)
          .map(([c, abs]) => `- \`${c}\` ← ${abs.map((a) => `\`${a}\``).join(' · ')}`),
        ...(mergeReport.merged.size > 40 ? [`- …and ${mergeReport.merged.size - 40} more`] : []),
        '',
      ]
    : []),
  ...(collisions.length
    ? [
        'UNDECLARED COLLISIONS — either one person (add a HANDLE_ALIASES entry in',
        'scripts/players.ts) or two (add the key to DISTINCT_KEYS). Undecided means',
        'one player reads as two, or two read as one, and the page looks right either way:',
        '',
        ...collisions.map((c) => `- \`${c.key}\` — ${c.handles.join(' · ')}`),
        '',
      ]
    : []),
  ...formatCrossCheck(witnessArtifact),
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
