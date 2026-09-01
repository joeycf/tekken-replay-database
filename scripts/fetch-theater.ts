// Stage 1 for the INDEX intake: pull Replay Theater's tagged Tekken 8 tournament
// matches, join each to the YouTube metadata of the VOD it points into, and
// dump the result to raw/replayTheater.json.
//
// Run: npm run data:theater   (and now: every morning, from the cron)
//
// THE POSTURE CHANGED ON 2026-08-31, and the old one is worth stating because
// this comment used to argue the opposite. It said a third party's uptime and
// goodwill should not become a cron dependency on day one of an integration,
// and it was right — on day one. The trust is re-measured on every pull rather
// than trusted from the day it was taken (the catalogue's own offsets against
// the uploaders' chapter markers, below, over the 27 of 62 source VODs that
// publish one), the first ingest overlapped nothing this repo had already
// fetched, published or ruled on — 0 of 317 — and the catalogue's operator is a
// collaborator rather than a stranger. replaytheater.app/robots.txt read
// 2026-08-31 is `User-agent: * / Disallow:`; requests carry a contactable
// user-agent and the catalogue's own pacing.
//
// WHAT MAKES IT SAFE IS NOT THE RELATIONSHIP, THOUGH — it is two rules that hold
// even when the goodwill does not:
//
//   1. ADD-ONLY. This intake can only ADD records. A committed record is carried
//      regardless of what the catalogue says today; entries that vanish are
//      COUNTED in report.md, never removed, and the pin only grows.
//   2. THE CRON NEVER DEPENDS ON THIS SUCCEEDING. The step runs LAST and is
//      allowed to fail. On any failure — network, non-200, malformed page, a
//      uniqueness assert — there is simply no dump, parse.ts carries exactly as
//      it does today, and the cron stays green. A bad day upstream costs that
//      day's new entries and nothing else.
//
// THE CASE FOR A CADENCE IS WEAKER HERE THAN IN THE SIBLING, and pretending
// otherwise would be the dishonest part. This is a CLOSED HISTORICAL SET: the
// catalogue's tagged Tekken rows stop at 2025-03-16 and it has added none in
// 2026, so the expected yield of any given morning is zero and the ORDINARY
// outcome is an empty dump and a carry. What the cron buys is that the day the
// set stops being closed nobody has to remember this command — and under the
// cursor below that costs two pages a morning, which is a price worth paying
// for not depending on a human noticing.
//
// AND WHAT MAKES IT AFFORDABLE is that cursor. A full sweep of this game alone
// is 230 pages of 50; sending that to a fellow fan project every morning is not
// a design. The catalogue orders newest-first, so the daily path reads the front
// and stops.
//
// WHAT IT IS NOT. Replay Theater hosts no video. It is an index: a match is a
// (videoId, startSeconds) pair plus players, characters and an event tag. So a
// record here is a SEGMENT — 285 of the 317 share a VOD with another — and its id
// is `${videoId}@${startSeconds}`, never a YouTube id.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS } from './channels';
import { fetchVideoMeta, requireApiKey, sleep } from './youtube';
import type { TheaterRawRecord } from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW_DIR = join(ROOT, 'raw');
const OUT = join(RAW_DIR, 'replayTheater.json');
/** What the pull learned about ITSELF, beside the dump. parse.ts reads it to
 *  learn which MODE produced the dump and how far the cursor got, and to state
 *  the collapse below in report.md rather than absorb it — the collapsed entries
 *  are gone from the dump by the time parse sees it, so nothing else can
 *  reconstruct that number. Absent on a run that never pulled, which is a
 *  different thing from a pull that found nothing and is reported as such. */
const STATS = join(RAW_DIR, '.replayTheater.stats.json');
/** EVERY entry this run saw, tagged and untagged, in the catalogue's own
 *  shape. Kept OUT of raw/replayTheater.json on purpose: that file is the INTAKE
 *  and parse.ts builds a record from every row in it, so an untagged row landing
 *  there would publish online ranked play as a tournament match. This file is
 *  the WITNESS — nothing reads it yet, and whatever does will build nothing. */
const WITNESS = join(RAW_DIR, 'replayTheater.witness.json');
/** The cursor's committed state: the highest catalogue entry id ever seen, so a
 *  run knows where "already seen" starts without re-reading 230 pages. Written
 *  by parse.ts (every data/ write is parse's), read here. */
const CURSOR = join(ROOT, 'data', 'theater-cursor.json');
/** Resume cache for a --full sweep only. The cursor replaced it for the daily
 *  path: two resume mechanisms that can disagree are worse than one, and this
 *  one skipped pages 2..N on any re-pull because it records page NUMBERS
 *  against a catalogue that grows at the FRONT. Deleted on every successful
 *  run, so it can only ever span one interrupted sweep. */
const PARTIAL = join(RAW_DIR, '.replayTheater.partial.json');

const CH = CHANNELS.find((c) => c.id === 'replayTheater');
if (!CH?.index) throw new Error('replayTheater is not registered as an index channel');
const INDEX = CH.index;
/** Pulled out of CH here because the cursor and the pin are both read inside
 *  main(), and the narrowing the throw above performs does not follow a
 *  hoisted function declaration in. */
const CH_ID = CH.id;

// ── flags ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FRESH = argv.includes('--fresh');
/** THE DAILY PATH is the cursor. `--full` forces the whole-catalogue sweep,
 *  which is what `--fresh` has always meant here and what a periodic
 *  reconciliation still wants. */
const FULL = argv.includes('--full') || FRESH;
const CURSOR_MODE = !FULL;
/** Two clean pages, not one. The catalogue orders `upload_date DESC, id ASC`, so
 *  a day's submissions can straddle a page boundary and a single clean page is
 *  not proof there is nothing behind it. */
const CLEAN_PAGES_TO_STOP = 2;
/** A hard ceiling on the daily path, so a catalogue-side reordering can never
 *  turn the cron into a 230-page sweep. Measured 2026-08-31 against the last
 *  full sweep: the newest 200 entries by id sit within page 5, and the feed runs
 *  12.2 entries a day over its 945 days — so ten pages is 500 entries, roughly
 *  forty days of submissions, ~5x the headroom the front of the feed needs.
 *  Hitting it is reported, not silent: under add-only nothing is lost, only
 *  late, and `npm run data:theater -- --full` reconciles. */
const CURSOR_MAX_PAGES = 10;
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
// `--max-pages` with no value yields NaN, and Math.min(pages, NaN) is NaN — the
// loop then never runs and you silently get page 1. A flag that is present must
// carry a usable number or stop the run.
const maxPagesRaw = opt('--max-pages');
let MAX_PAGES = Infinity;
if (argv.includes('--max-pages')) {
  const n = Number(maxPagesRaw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`✖ --max-pages needs a positive integer (got ${JSON.stringify(maxPagesRaw)}).`);
    process.exit(1);
  }
  MAX_PAGES = n;
}

requireApiKey('data:theater');

const pct = (n: number, total: number) => (total === 0 ? '0.0' : ((n / total) * 100).toFixed(1));

// ── the index API ───────────────────────────────────────────────────────────

/** One entry exactly as the catalogue publishes it. Everything is nullable:
 *  this is someone else's schema and we do not get to assume. */
interface TheaterEntry {
  id?: number;
  game?: string | null;
  video_link?: string | null;
  tag?: string | null;
  upload_date?: string | null;
  p1_name?: string | null;
  p2_name?: string | null;
  p1_char?: string | null;
  p1_char2?: string | null;
  p1_char3?: string | null;
  p1_char4?: string | null;
  p2_char?: string | null;
  p2_char2?: string | null;
  p2_char3?: string | null;
  p2_char4?: string | null;
}
interface TheaterPage {
  matches?: TheaterEntry[];
  total_count?: number | string;
}

async function getPage(page: number, retries = 4): Promise<TheaterPage> {
  const url = `${INDEX.endpoint}?game=${encodeURIComponent(INDEX.slug)}&page=${page}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          // Identify the client. This is a fellow fan project, not a target.
          'user-agent': 'replay-database/tekken (+https://github.com/joeycf) data:theater',
        },
      });
      if (res.ok) return (await res.json()) as TheaterPage;
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status} (not retryable)\n${await res.text().catch(() => '')}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= retries || msg.includes('not retryable')) {
        throw new Error(`Replay Theater page ${page} failed: ${msg}`, { cause: err });
      }
      const wait = Math.min(1500 * 2 ** (attempt - 1), 10_000);
      console.warn(
        `  ⚠ page ${page} (attempt ${attempt}/${retries}): ${msg}; retrying in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  throw new Error(`Exhausted retries for page ${page}`);
}

// ── video link → (videoId, startSeconds) ────────────────────────────────────
//
// THE LINKS ARE CONCATENATED, NOT BUILT. Replay Theater's submission form does
// `video_link = base + "&t=" + t + "s"` regardless of what `base` looks like,
// so a youtu.be submission produces `https://youtu.be/<id>&t=554s` — a PATH
// with no query string at all. 210 of the 317 tagged Tekken entries are that
// shape — TWO THIRDS, the highest share of any game in the catalogue. A
// URL-parsing extractor reads the id as "abcdefghijk&t=554s"; this matches the
// id shape explicitly and refuses anything else rather than guessing.
const VIDEO_ID =
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/(?:live|shorts|embed)\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

// GLOBAL, and the LAST match wins. The form appends its own offset last, so an
// earlier `t=` is whatever the submitter's clipboard carried in — a share link
// already carrying a timestamp. Taking the first reads the clipboard and throws
// away the catalogue's own value; measured in the sibling SF6 catalogue, that
// collapses four distinct matches onto one id, which the uniqueness check below
// would then report as a collision it cannot explain.
const START_ALL = /[?&]t=([^&#]*)/g;
const START_VALUE = /^(\d+)s?$/;

interface Link {
  videoId: string;
  startSeconds: number;
  /** How many `t=` params the link carried; >1 is worth seeing in recon. */
  tCount: number;
}

function parseLink(link: string): Link | { error: string } {
  const id = VIDEO_ID.exec(link ?? '');
  if (!id) return { error: 'no extractable YouTube id' };
  const values = [...(link ?? '').matchAll(START_ALL)].map((m) => m[1] ?? '');
  if (values.length === 0) return { videoId: id[1]!, startSeconds: 0, tCount: 0 };
  const last = values[values.length - 1]!;
  const m = START_VALUE.exec(last);
  // A `t=` we cannot read is NOT the same as no `t=`. Falling through to 0
  // would publish a segment that starts at the top of a three-hour VOD and
  // renders exactly like a correct one.
  if (!m) return { error: `unreadable t= value ${JSON.stringify(last)}` };
  return { videoId: id[1]!, startSeconds: Number(m[1]), tCount: values.length };
}

// ── chapters, derived from the description ──────────────────────────────────
//
// RECON ONLY — this produces no field and gates nothing. MatchVideo has no
// `round` and no `tournament`, so the reference's round-harvesting has no
// destination here and is not ported. What survives is the measurement this
// intake was admitted on: the catalogue's offsets against the uploaders' own
// chapter markers, re-run on every pull rather than trusted from the day it was
// first taken. Note only 27 of the 62 VODs carry a chapter list, so the check
// covers ~86% of the records and the rest are unverifiable by this means.
//
// The rule YouTube applies: timestamped lines, at least three, the first at
// 0:00. The last test matters — a description that merely mentions a time is
// not a chapter list.
const CHAPTER_LINE =
  /^\s*(?:\[|\()?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\]|\))?\s*[-–—:|]?\s*(.+?)\s*$/;

interface Chapter {
  start: number;
  title: string;
}

function chaptersOf(description: string): Chapter[] {
  const out: Chapter[] = [];
  for (const line of (description ?? '').split('\n')) {
    const m = CHAPTER_LINE.exec(line);
    if (!m) continue;
    const [, a, b, c, title] = m;
    const start = c ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
    if (title?.trim()) out.push({ start, title: title.trim() });
  }
  if (out.length < 3 || out[0]!.start !== 0) return [];
  return out.sort((x, y) => x.start - y.start);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });

  // CLEAR THE PREVIOUS RUN'S SELF-REPORT BEFORE FETCHING ANYTHING. parse.ts
  // reads .replayTheater.stats.json to learn what this pull did — its mode, its
  // page count, and the cursor it reached — and a file left over from yesterday
  // would answer those questions about the wrong run. Specifically: a pull that
  // dies on its first request writes nothing, so parse would find yesterday's
  // stats, report "the pull found no new entries" instead of "no pull this run",
  // and re-advance the cursor off a number this run never observed.
  //
  // Invisible in CI, where a fresh checkout has no raw/ at all — which is
  // exactly why it is done here rather than trusted to the environment.
  await rm(STATS, { force: true });
  await rm(WITNESS, { force: true });

  // Resume: a partial sweep is keyed by Replay Theater's own entry id, so a
  // re-run after an interruption re-fetches only the pages it never saw and the
  // overlap merges rather than duplicating. FULL SWEEPS ONLY now — it records
  // page NUMBERS against a catalogue that grows at the front, so on the daily
  // path it would mark page 1 seen and skip everything new tomorrow. The cursor
  // is the daily path's resume mechanism, and two that can disagree are worse
  // than one.
  const byTheaterId = new Map<number, TheaterEntry>();
  let seenPages = new Set<number>();
  if (FULL && !FRESH && existsSync(PARTIAL)) {
    try {
      const prev = JSON.parse(await readFile(PARTIAL, 'utf8')) as {
        pages: number[];
        entries: TheaterEntry[];
      };
      for (const e of prev.entries) if (e.id != null) byTheaterId.set(e.id, e);
      seenPages = new Set(prev.pages);
      console.log(
        `  ↻ resuming: ${byTheaterId.size} entr(ies) from ${seenPages.size} cached page(s)`,
      );
    } catch {
      console.warn('  ⚠ unreadable partial cache — starting fresh');
    }
  }

  // ── THE CURSOR ────────────────────────────────────────────────────────────
  // The catalogue orders `upload_date DESC, id ASC` and entry ids increase with
  // submission, so "have I seen everything new?" is answerable from the front of
  // the feed alone: page until CLEAN_PAGES_TO_STOP consecutive pages offer no id
  // above the committed cursor. Verified across a page boundary in the last full
  // sweep — page 1 ends 2026-08-25/487105 and page 2 begins 2026-08-25/487106,
  // the same date continuing with the next id. (Three of the 11,490 entries
  // break the id tie-break, all of them past page 160; the front of the feed,
  // which is all the cursor reads, is clean.)
  //
  // WHY NOT `?since=` OR A REAL CURSOR: there isn't one. Probed 2026-08-31 —
  // `since`, `limit`, `per_page`, `sort`, `order` and `after_id` are all
  // accepted and silently IGNORED (byte-identical responses). Only `game` and
  // `page` are honoured, and `game` is validated: an unrecognised slug returns
  // "Invalid game" rather than falling through to the unfiltered catalogue,
  // which is worth knowing — the per-entry game gate below is a second line, not
  // the only one.
  //
  // WHAT THE CURSOR CANNOT SEE, stated rather than hidden: the ordering key is
  // the VIDEO's upload date, not the submission's. Someone submitting a 2024 VOD
  // today lands deep in the feed, behind the bound, and this run will not reach
  // it. Under add-only that is late, never lost — the entry keeps its id, a
  // --full sweep collects it, and nothing already committed is affected.
  //
  // AND IN THIS REPO THAT IS THE EXPECTED CASE, not the edge one. The tagged
  // Tekken rows stop at 2025-03-16 while the feed's front is current, so the
  // shallowest tagged entry in the last full sweep sat on page 97 of 230. A
  // cursor run reads the untagged 2026 front, writes an empty dump, and parse
  // carries — which is why parse.ts treats an empty dump as an explicit carry
  // and why the cursor is keyed on the PULL having happened rather than on
  // records having been built.
  const cursorFile = await readFile(CURSOR, 'utf8')
    .then((t) => JSON.parse(t) as Record<string, number>)
    .catch(() => ({}) as Record<string, number>);
  const cursorAt = cursorFile[CH_ID] ?? 0;

  console.log(`\n▶ Pulling the Replay Theater index (${INDEX.endpoint}, game=${INDEX.slug})…`);
  const first = await getPage(1);
  const total = Number(first.total_count ?? 0);
  const fullPages = Math.ceil(total / INDEX.pageSize);
  const pages = Math.min(CURSOR_MODE ? CURSOR_MAX_PAGES : fullPages, MAX_PAGES);
  console.log(
    CURSOR_MODE
      ? `  catalogue reports ${total} match(es) (${fullPages} page(s) of ${INDEX.pageSize}); cursor at entry id ${cursorAt || '—'}, reading at most ${pages}`
      : `  catalogue reports ${total} match(es) → ${pages} page(s) of ${INDEX.pageSize}`,
  );
  for (const e of first.matches ?? []) if (e.id != null) byTheaterId.set(e.id, e);
  seenPages.add(1);

  let cleanRun = (first.matches ?? []).some((e) => (e.id ?? 0) > cursorAt) ? 0 : 1;
  let pagesRead = 1;
  let stoppedEarly = false;
  for (let p = 2; p <= pages; p++) {
    if (CURSOR_MODE && cleanRun >= CLEAN_PAGES_TO_STOP) {
      stoppedEarly = true;
      break;
    }
    if (seenPages.has(p)) continue;
    await sleep(INDEX.pacingMs);
    const data = await getPage(p);
    const rows = data.matches ?? [];
    for (const e of rows) if (e.id != null) byTheaterId.set(e.id, e);
    seenPages.add(p);
    pagesRead++;
    cleanRun = rows.some((e) => (e.id ?? 0) > cursorAt) ? 0 : cleanRun + 1;
    // An empty page is the END OF THE CATALOGUE, not a clean page to count
    // towards the stop condition — counting it would be reading "there is
    // nothing after this" as evidence about what came before.
    if (rows.length === 0) {
      stoppedEarly = true;
      break;
    }
    if (!CURSOR_MODE && (p % 10 === 0 || p === pages)) {
      console.log(`  … page ${p}/${pages} (${byTheaterId.size} unique entries)`);
      await writeFile(
        PARTIAL,
        JSON.stringify({ pages: [...seenPages], entries: [...byTheaterId.values()] }),
        'utf8',
      );
    }
  }
  if (CURSOR_MODE && cleanRun >= CLEAN_PAGES_TO_STOP) stoppedEarly = true;
  const hitBound = CURSOR_MODE && !stoppedEarly && pagesRead >= pages;
  const catalogue = [...byTheaterId.values()];
  const maxEntryId = catalogue.reduce((m, e) => Math.max(m, e.id ?? 0), cursorAt);
  console.log(
    CURSOR_MODE
      ? `  read ${pagesRead} page(s), ${catalogue.length} entr(ies); ${catalogue.filter((e) => (e.id ?? 0) > cursorAt).length} newer than the cursor → new cursor ${maxEntryId}`
      : `  pulled ${catalogue.length} unique entr(ies)`,
  );
  if (hitBound) {
    console.log(
      `  ⚠ the cursor hit its ${CURSOR_MAX_PAGES}-page bound without going quiet — entries may be\n` +
        `    unreached this run. Nothing is lost (add-only), only late; run\n` +
        `    \`npm run data:theater -- --full\` to reconcile.`,
    );
  }

  // ── the game gate, PER ENTRY ──────────────────────────────────────────────
  // `?game=tkn8` is a query someone else answers, and an index is a strictly
  // weaker guarantee than a channel: a mistagged submission would arrive
  // looking exactly like a real one. Every entry states its own game, so check
  // that instead of the query.
  const want = INDEX.gameLabel.toUpperCase();
  const wrongGame = catalogue.filter((e) => (e.game ?? '').trim().toUpperCase() !== want);
  const rightGame = catalogue.filter((e) => (e.game ?? '').trim().toUpperCase() === want);
  if (wrongGame.length) {
    console.log(
      `  ⚠ ${wrongGame.length} entr(ies) rejected — entry.game is not ${INDEX.gameLabel}:`,
    );
    for (const e of wrongGame.slice(0, 10)) {
      console.log(`      #${e.id} game=${JSON.stringify(e.game)} ${e.video_link ?? ''}`);
    }
    if (wrongGame.length > 10) console.log(`      … ${wrongGame.length - 10} more`);
  }

  // ── scope: tagged tournament matches only ─────────────────────────────────
  // The untagged remainder is online ranked play. This repo already carries
  // three channels of that; what it is worst at is tournament sets. Tagged rows
  // are 317 of the catalogue's 11,490 — 2.8% — so a pull that returns none is
  // the ordinary case, not a failure.
  const tagged = rightGame.filter((e) => (e.tag ?? '').trim() !== '');
  console.log(
    `  ${tagged.length} tagged tournament match(es); ${rightGame.length - tagged.length} untagged (out of scope)`,
  );

  // ── links ─────────────────────────────────────────────────────────────────
  const linked: Array<{ e: TheaterEntry; link: Link }> = [];
  const unparseable: Array<{ e: TheaterEntry; why: string }> = [];
  for (const e of tagged) {
    const got = parseLink(e.video_link ?? '');
    if ('error' in got) unparseable.push({ e, why: got.error });
    else linked.push({ e, link: got });
  }
  if (unparseable.length) {
    console.error(`\n✖ ${unparseable.length} tagged entr(ies) have an unusable video link:`);
    for (const u of unparseable.slice(0, 10)) {
      console.error(`    #${u.e.id} ${u.why} — ${JSON.stringify(u.e.video_link)}`);
    }
    console.error('  Refusing rather than guessing — an id and an offset are not approximations.');
    process.exit(1);
  }

  // ── the same event, submitted twice ───────────────────────────────────────
  //
  // A (videoId, startSeconds) pair IS the record id, so two entries sharing one
  // would mean two records competing for it and one silently overwriting the
  // other. This used to exit 1 on the first pair, full stop. That was the right
  // shape while a human ran the pull and read the output; on a cron it means one
  // double-submitted event upstream turns the morning red every morning until
  // someone intervenes, which is how a guard becomes a flag people learn to
  // pass.
  //
  // So the ONE shape that is explicable is collapsed first, deterministically,
  // and COUNTED — a silent collapse is indistinguishable from a parser that lost
  // records. That shape is the same event submitted twice under two tag
  // spellings, which the sibling SF6 catalogue carries 35 of ("Team Battle
  // 10vs10 ACS vs TOBLS" and "ACS vs TOBLS 10v10": identical players,
  // characters, videoId and offset). This catalogue carries none today — the
  // collapse is here because the cron cannot wait for the day it does.
  //
  // THE TIE IS BROKEN ON THE TAG SPELLING, not on the catalogue's entry ids:
  // entry ids reflect submission order, which would make the surviving copy
  // depend on which of two identical rows happened to be typed first.
  //
  // SAMENESS IS THE FULL CHARACTER TUPLE, and that is this repo's widening of
  // the sibling's predicate. There the comparison is p1_name/p2_name plus
  // p1_char/p2_char, which is complete for a game where a side is one character.
  // A Tekken entry can carry char2..char4, so comparing only the first slot
  // would call two genuinely different records "the same match" and discard one
  // — silently, since the collapse is the branch that does not stop the run.
  const byKey = new Map<string, Array<{ e: TheaterEntry; link: Link }>>();
  for (const l of linked) {
    const key = `${l.link.videoId}@${l.link.startSeconds}`;
    byKey.set(key, [...(byKey.get(key) ?? []), l]);
  }
  // POSITIONAL and not compacted, unlike `chars` below: the empty slots are part
  // of the comparison, so a bench that shifted between two submissions reads as
  // a different tuple rather than the same one.
  const sideChars = (e: TheaterEntry, side: 1 | 2): string =>
    ([`p${side}_char`, `p${side}_char2`, `p${side}_char3`, `p${side}_char4`] as const)
      .map((k) => (e as Record<string, unknown>)[k])
      .map((c) => (typeof c === 'string' ? c.trim() : ''))
      .join('|');
  const deduped: Array<{ e: TheaterEntry; link: Link }> = [];
  const collapsedTags = new Map<string, number>();
  let collapsed = 0;
  const collisions: string[] = [];
  for (const [key, group] of byKey) {
    if (group.length === 1) {
      deduped.push(group[0]!);
      continue;
    }
    const head = group[0]!.e;
    const sameMatch = group.every(
      (g) =>
        (g.e.p1_name ?? '') === (head.p1_name ?? '') &&
        (g.e.p2_name ?? '') === (head.p2_name ?? '') &&
        sideChars(g.e, 1) === sideChars(head, 1) &&
        sideChars(g.e, 2) === sideChars(head, 2),
    );
    if (sameMatch) {
      const sorted = [...group].sort((a, b) =>
        (a.e.tag ?? '').trim().localeCompare((b.e.tag ?? '').trim()),
      );
      deduped.push(sorted[0]!);
      collapsed += group.length - 1;
      const pair = [...new Set(group.map((g) => (g.e.tag ?? '').trim()))].sort().join('  ||  ');
      collapsedTags.set(pair, (collapsedTags.get(pair) ?? 0) + group.length - 1);
      continue;
    }
    collisions.push(
      [
        `  ${key}`,
        ...group.map(
          (g) => `    #${g.e.id}  ${g.e.p1_name} vs ${g.e.p2_name}  [${(g.e.tag ?? '').trim()}]`,
        ),
      ].join('\n'),
    );
    deduped.push(group[0]!);
  }
  if (collapsed > 0) {
    console.log(`\n  collapsed ${collapsed} double-submitted entr(ies) — same match, two tags:`);
    for (const [pair, n] of [...collapsedTags].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${n}×  ${pair}`);
    }
  }
  if (collisions.length) {
    console.error(
      `\n✖ ${collisions.length} (videoId, startSeconds) collision(s) this cannot explain:`,
    );
    console.error(collisions.join('\n'));
    console.error(
      [
        '  That pair IS the record id, so one entry would silently overwrite the other.',
        '  These are not the same match under two tag spellings, which is handled above.',
        '  Two genuinely different matches whose links defeat the offset reader need the',
        '  reader fixed, not the assert loosened.',
      ].join('\n'),
    );
    process.exit(1);
  }

  // ── join to YouTube ───────────────────────────────────────────────────────
  const vodIds = [...new Set(deduped.map((l) => l.link.videoId))];
  console.log(`\n▶ Fetching YouTube metadata for ${vodIds.length} source VOD(s)…`);
  const vods = await fetchVideoMeta(vodIds);
  const missingVods = vodIds.filter((id) => !vods.has(id));
  if (missingVods.length) {
    // Reported, never silent. A VOD gone private or deleted takes its matches
    // with it, and that is a fact about the corpus, not noise.
    console.log(`  ⚠ ${missingVods.length} VOD(s) no longer resolve (private/deleted):`);
    for (const id of missingVods) {
      const n = deduped.filter((l) => l.link.videoId === id).length;
      const tag = deduped.find((l) => l.link.videoId === id)?.e.tag ?? '?';
      console.log(`      ${id}  ${n} match(es)  [${tag}]`);
    }
  }

  const chars = (e: TheaterEntry, side: 1 | 2): string[] =>
    ([`p${side}_char`, `p${side}_char2`, `p${side}_char3`, `p${side}_char4`] as const)
      .map((k) => (e as Record<string, unknown>)[k])
      .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      .map((c) => c.trim());

  const records: TheaterRawRecord[] = [];
  for (const { e, link } of deduped) {
    const vod = vods.get(link.videoId);
    if (!vod) continue; // unresolvable VOD, already reported
    const c1 = chars(e, 1);
    const c2 = chars(e, 2);
    records.push({
      id: `${link.videoId}@${link.startSeconds}`,
      channel: 'replayTheater',
      // SYNTHESIZED — the catalogue carries no title. It follows telly's ▰
      // shape (the corpus's dominant grammar) so cards read consistently, and
      // it carries the event tag in the trailing slot because `title` is the
      // engine's search haystack: that placement is what makes "ParagOnline
      // #23" and "CEOtaku 2024" findable with no new facet, field or render
      // surface — this repo models no event entity at all. Handles keep their
      // sponsor prefixes; stripping is the parser's job.
      title: `Tekken 8 ▰ ${e.p1_name ?? '?'} (${c1.join('/')}) vs ${e.p2_name ?? '?'} (${c2.join('/')}) ▰ ${(e.tag ?? '').trim()}`,
      description: '',
      // The VOD's real publish time. Deliberately NOT offset by startSeconds:
      // that would shift a record by up to several hours and could cross a
      // day-grained patch boundary, which is the authority era and patch are
      // derived from. Sets within one VOD therefore share a timestamp — which
      // is exactly why parse.ts sorts with a tie-break.
      publishedAt: vod.publishedAt,
      // The catalogue publishes no per-match duration and there is nothing
      // honest to derive one from: the gap to the next set includes the
      // downtime between them. 0 means unknown; emit omits the field.
      durationSec: 0,
      liveBroadcastContent: 'none',
      theaterId: e.id!,
      videoId: link.videoId,
      startSeconds: link.startSeconds,
      tag: (e.tag ?? '').trim(),
      uploader: vod.uploader,
      players: [(e.p1_name ?? '').trim(), (e.p2_name ?? '').trim()],
      characters: [c1, c2],
    });
  }

  // Stable, TOTAL order: newest VOD first, then by offset within the VOD, then
  // by id. Sets inside one VOD share a publishedAt, so a comparator without the
  // final tie-break would be free to return a different permutation per run and
  // a re-pull that changed nothing would still produce a diff.
  records.sort(
    (a, b) =>
      b.publishedAt.localeCompare(a.publishedAt) ||
      a.startSeconds - b.startSeconds ||
      a.id.localeCompare(b.id),
  );

  // ── the floor, on a FULL sweep only ───────────────────────────────────────
  // A cursor run's dump is a DELTA and is legitimately tiny — usually empty in
  // this repo — so "materially smaller than the pin" means nothing there:
  // parse.ts merges it add-only and that is what does the protecting. A FULL
  // sweep is different. It CLAIMS to be the whole catalogue, so a collapse in it
  // is a claim that most of the catalogue is gone.
  //
  // The shape this guards against is not hypothetical. `records` is filtered by
  // the per-entry game gate above, and that gate compares against a string the
  // catalogue controls: the day "Tekken 8" is renamed upstream, `rightGame` is
  // 0, `records` is 0, and the old code wrote `[]` over a good dump without
  // comment. Downstream that reads as 317 → 0 and trips the collapse guard, so
  // the cron goes red for a reason nothing in the failure names. Refuse here,
  // where the cause is visible and nameable.
  if (FULL) {
    const pins = await readFile(join(ROOT, 'data', 'source-pins.json'), 'utf8')
      .then((t) => JSON.parse(t) as Record<string, number>)
      .catch(() => ({}) as Record<string, number>);
    const pinned = pins[CH_ID] ?? 0;
    if (pinned > 0 && records.length < pinned * 0.9) {
      console.error(
        [
          `\n✖ A full sweep produced ${records.length} record(s) against a committed pin of ${pinned}.`,
          `  That is a claim that ${pinned - records.length} tournament matches left the catalogue at once.`,
          ``,
          `  The likeliest cause is not deletion. Every entry is checked against`,
          `  gameLabel ${JSON.stringify(INDEX.gameLabel)}, and ${wrongGame.length} of ${catalogue.length} entr(ies) failed that check`,
          `  this run — if the catalogue renamed the game, every row fails and this`,
          `  file would be overwritten with almost nothing.`,
          ``,
          `  Refusing to write. The committed records are untouched and the cron`,
          `  carries them exactly as it does on a day this never ran.`,
          `  If the drop is real: npm run data:theater -- --full --allow-shrink`,
        ].join('\n'),
      );
      if (!argv.includes('--allow-shrink')) process.exit(1);
    }
  }

  await writeFile(OUT, JSON.stringify(records, null, 1) + '\n', 'utf8');

  // ── the witness ───────────────────────────────────────────────────────────
  // EVERY entry the run saw, tagged and untagged, in the catalogue's own shape.
  // The untagged remainder is online ranked play and is out of INGESTION scope
  // by design — but it is not out of scope as EVIDENCE: it is an independent
  // second reading of players and characters for videos this repo may already
  // have title-parsed, which is the substrate a cross-check would need.
  //
  // WRITTEN SEPARATELY FROM THE INTAKE DUMP, and that separation is the whole
  // safety property: parse.ts builds one record per row of
  // raw/replayTheater.json, so an untagged row landing in that file would
  // publish somebody's online ranked set as a tournament match. Nothing reads
  // this file yet.
  await writeFile(
    WITNESS,
    JSON.stringify(
      {
        mode: CURSOR_MODE ? 'cursor' : 'full',
        maxEntryId,
        pagesRead,
        hitBound,
        // BEHIND THE PER-ENTRY GAME GATE, not the raw catalogue. The gate is this
        // intake's only real defence against a response that is not what was asked
        // for, and the witness has to sit behind it too — it feeds a comparison
        // whose whole claim is that it is reading THIS game.
        //
        // Not hypothetical. On 2026-08-31 a `--full` sweep in tokon-replay-database
        // resumed from a partial cache left over from an era when this endpoint
        // returned everything, and wrote 15,286 Street Fighter 6 rows into a
        // 266-entry Tokon witness. The intake was untouched — the gate did its job
        // there — but the witness was 98% another game, and nothing downstream
        // would have said so.
        entries: rightGame,
      },
      null,
      1,
    ) + '\n',
    'utf8',
  );

  await writeFile(
    STATS,
    JSON.stringify(
      {
        // THE MODE IS LOAD-BEARING, not a diagnostic. parse.ts reads it to
        // decide whether this dump is the whole catalogue or a delta, which
        // decides whether "committed but absent from the dump" means "vanished
        // upstream" or "simply not in the pages we read".
        mode: CURSOR_MODE ? 'cursor' : 'full',
        maxEntryId,
        pagesRead,
        hitBound,
        catalogue: catalogue.length,
        rightGame: rightGame.length,
        tagged: tagged.length,
        collapsed,
        collapsedTags: Object.fromEntries(collapsedTags),
        unresolvableVods: missingVods.length,
        records: records.length,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // The resume cache is for ONE interrupted sweep and nothing more. It records
  // page NUMBERS against a catalogue that grows at the front, so a stale one
  // makes anything past the first page permanently invisible to the next sweep
  // until someone remembers --fresh. A successful run clears it, which also
  // means the daily path can never inherit one.
  if (existsSync(PARTIAL)) await rm(PARTIAL, { force: true });

  console.log(
    `\n  → wrote raw/replayTheater.json (${records.length} record(s)${CURSOR_MODE ? ', a delta' : ''})`,
  );
  console.log(`  → wrote raw/replayTheater.witness.json (${catalogue.length} catalogue entr(ies))`);

  // ── reconnaissance ────────────────────────────────────────────────────────
  console.log(`\n${'█'.repeat(72)}`);
  console.log('  RECONNAISSANCE — replayTheater');
  console.log('█'.repeat(72));
  console.log(`\n  mode:                            ${CURSOR_MODE ? 'cursor' : 'full'}`);
  console.log(
    `  pages read:                      ${pagesRead}${hitBound ? ' (hit the bound)' : ''}`,
  );
  console.log(`  catalogue (game=${INDEX.slug}):     ${catalogue.length}`);
  console.log(`  rejected by the per-entry gate:  ${wrongGame.length}`);
  console.log(`  tagged tournament matches:       ${tagged.length}`);
  console.log(`  collapsed as double-submitted:   ${collapsed}`);
  console.log(`  written (VOD resolvable):        ${records.length}`);

  const malformed = deduped.filter((l) => {
    const s = l.e.video_link ?? '';
    if (!s.includes('youtu.be/')) return false;
    const tail = s.split('youtu.be/')[1] ?? '';
    return tail.includes('&t=') && !tail.includes('?');
  }).length;
  const multiT = deduped.filter((l) => l.link.tCount > 1).length;
  console.log(
    `\n  concatenated youtu.be/<id>&t=Ns links: ${malformed} (${pct(malformed, deduped.length)}%)`,
  );
  console.log(`  links carrying more than one t=:       ${multiT} (last one wins)`);
  console.log(
    `  records at offset 0:                   ${records.filter((r) => r.startSeconds === 0).length}`,
  );

  const byTag = new Map<string, number>();
  for (const r of records) byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + 1);
  const byVod = new Map<string, number>();
  for (const r of records) byVod.set(r.videoId, (byVod.get(r.videoId) ?? 0) + 1);
  const perVod = [...byVod.values()].sort((a, b) => a - b);
  console.log(`\n  distinct event tags:  ${byTag.size}`);
  console.log(
    `  distinct source VODs: ${byVod.size}  (min ${perVod[0] ?? 0} / median ${perVod[perVod.length >> 1] ?? 0} / max ${perVod[perVod.length - 1] ?? 0} matches per VOD)`,
  );
  const dates = records.map((r) => r.publishedAt.slice(0, 10)).sort();
  console.log(`  date range:           ${dates[0] ?? '—'} … ${dates[dates.length - 1] ?? '—'}`);

  // Character slot occupancy — the fact that decides whether these records need
  // the bench machinery at all. Observed, never assumed.
  const occ = new Map<number, number>();
  for (const r of records)
    for (const side of r.characters) occ.set(side.length, (occ.get(side.length) ?? 0) + 1);
  console.log(
    `\n  characters per side: ${[...occ.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, n]) => `${k}→${n}`)
      .join(' · ')}`,
  );

  // ── trust, re-measured every pull ─────────────────────────────────────────
  let inChapter = 0;
  let exact = 0;
  let within30 = 0;
  let vsChapters = 0;
  let namesAgree = 0;
  let chaptered = 0;
  for (const [id, meta] of vods) {
    const cs = chaptersOf(meta.description);
    if (cs.length) chaptered++;
    if (!cs.length) continue;
    for (const r of records.filter((x) => x.videoId === id)) {
      let hit: Chapter | undefined;
      for (const c of cs) {
        if (c.start <= r.startSeconds) hit = c;
        else break;
      }
      if (!hit) continue;
      inChapter++;
      const d = r.startSeconds - hit.start;
      if (d === 0) exact++;
      if (Math.abs(d) <= 30) within30++;
      // Condition on the chapter naming a MATCHUP, not on a name having
      // already hit: the looser denominator silently excludes total
      // disagreement, which is the one failure that matters.
      if (/\bvs\.?\b/i.test(hit.title)) {
        vsChapters++;
        const t = norm(hit.title);
        const [p1, p2] = r.players.map(norm);
        if (p1 && p2 && t.includes(p1) && t.includes(p2)) namesAgree++;
      }
    }
  }
  console.log(`\n  VODs carrying a chapter list: ${chaptered}/${vods.size}`);
  console.log(
    `  offsets inside a chapter:     ${inChapter} — ${within30} within 30s (${pct(within30, inChapter)}%), ${exact} exact (${pct(exact, inChapter)}%)`,
  );
  console.log(
    `  chapters naming a matchup:    ${vsChapters} — both handles agree ${namesAgree} (${pct(namesAgree, vsChapters)}%)`,
  );
  console.log(`  records with no chapter to check against: ${records.length - inChapter}`);

  const uploaders = new Map<string, number>();
  for (const r of records) uploaders.set(r.uploader, (uploaders.get(r.uploader) ?? 0) + 1);
  console.log(`\n  host channels (${uploaders.size}):`);
  for (const [name, n] of [...uploaders.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${name}`);
  }
  console.log(`\n  events (${byTag.size}):`);
  for (const [tag, n] of [...byTag.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${tag}`);
  }

  console.log(
    `\n✔ Stage 1 (index) complete — ${records.length} tagged tournament match(es) over ${byVod.size} VOD(s).`,
  );
  console.log('  Next: npm run data:parse');
}

main().catch((err) => {
  console.error(
    `\n✖ data:theater failed:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
