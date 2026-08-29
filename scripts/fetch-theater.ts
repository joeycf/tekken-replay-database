// Stage 1 for the INDEX intake: pull Replay Theater's tagged Tekken 8 tournament
// matches, join each to the YouTube metadata of the VOD it points into, and
// dump the result to raw/replayTheater.json.
//
// Run: npm run data:theater
//
// WHY THIS IS A SEPARATE COMMAND, and not part of data:fetch. data:fetch runs
// in the daily cron. A third party's uptime and goodwill should not become a
// cron dependency on day one of an integration, and committed records survive
// source loss anyway. So this is LOCAL-FIRST: run by hand, on a cadence a human
// chooses, and parse.ts carries the committed records forward on every run that
// finds no dump — which is every cron run.
//
// WHAT IT IS NOT. Replay Theater hosts no video. It is an index: a match is a
// (videoId, startSeconds) pair plus players, characters and an event tag. So a
// record here is a SEGMENT — 285 of the 317 share a VOD with another — and its id
// is `${videoId}@${startSeconds}`, never a YouTube id.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS } from './channels';
import { fetchVideoMeta, requireApiKey, sleep } from './youtube';
import type { TheaterRawRecord } from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW_DIR = join(ROOT, 'raw');
const OUT = join(RAW_DIR, 'replayTheater.json');
const PARTIAL = join(RAW_DIR, '.replayTheater.partial.json');

const CH = CHANNELS.find((c) => c.id === 'replayTheater');
if (!CH?.index) throw new Error('replayTheater is not registered as an index channel');
const INDEX = CH.index;

// ── flags ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FRESH = argv.includes('--fresh');
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

  // Resume: a partial pull is keyed by Replay Theater's own entry id, so a
  // re-run after an interruption re-fetches only the pages it never saw and the
  // overlap merges rather than duplicating. --fresh discards it.
  const byTheaterId = new Map<number, TheaterEntry>();
  let seenPages = new Set<number>();
  if (!FRESH && existsSync(PARTIAL)) {
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

  console.log(`\n▶ Pulling the Replay Theater index (${INDEX.endpoint}, game=${INDEX.slug})…`);
  const first = await getPage(1);
  const total = Number(first.total_count ?? 0);
  const pages = Math.min(Math.ceil(total / INDEX.pageSize), MAX_PAGES);
  console.log(`  catalogue reports ${total} match(es) → ${pages} page(s) of ${INDEX.pageSize}`);
  for (const e of first.matches ?? []) if (e.id != null) byTheaterId.set(e.id, e);
  seenPages.add(1);

  for (let p = 2; p <= pages; p++) {
    if (seenPages.has(p)) continue;
    await sleep(INDEX.pacingMs);
    const data = await getPage(p);
    for (const e of data.matches ?? []) if (e.id != null) byTheaterId.set(e.id, e);
    seenPages.add(p);
    if (p % 10 === 0 || p === pages) {
      console.log(`  … page ${p}/${pages} (${byTheaterId.size} unique entries)`);
      await writeFile(
        PARTIAL,
        JSON.stringify({ pages: [...seenPages], entries: [...byTheaterId.values()] }),
        'utf8',
      );
    }
  }
  const catalogue = [...byTheaterId.values()];
  console.log(`  pulled ${catalogue.length} unique entr(ies)`);

  // ── the game gate, PER ENTRY ──────────────────────────────────────────────
  // `?game=tokon` is a query someone else answers, and an index is a strictly
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
  // three channels of that; what it is worst at is tournament sets.
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

  // A (videoId, startSeconds) collision would mean two records competing for
  // one id. Assert it rather than discover it as a silently-dropped record
  // downstream: that pair IS the record id, so one would overwrite the other.
  const seen = new Map<string, TheaterEntry>();
  const collisions: string[] = [];
  for (const l of linked) {
    const key = `${l.link.videoId}@${l.link.startSeconds}`;
    const prev = seen.get(key);
    if (prev) {
      collisions.push(
        [
          `  ${key}`,
          `    #${prev.id}  ${prev.p1_name} vs ${prev.p2_name}  [${prev.tag}]`,
          `    #${l.e.id}  ${l.e.p1_name} vs ${l.e.p2_name}  [${l.e.tag}]`,
        ].join('\n'),
      );
    }
    seen.set(key, l.e);
  }
  if (collisions.length) {
    console.error(`\n✖ ${collisions.length} (videoId, startSeconds) collision(s):`);
    console.error(collisions.join('\n'));
    console.error(
      [
        '  That pair IS the record id, so one entry would silently overwrite the other.',
        '  Two shapes cause this and they need different answers: the same event',
        '  submitted twice under two tag spellings (dedupe it), or two genuinely',
        '  different matches whose links defeat the offset reader (fix the reader).',
      ].join('\n'),
    );
    process.exit(1);
  }

  // ── join to YouTube ───────────────────────────────────────────────────────
  const vodIds = [...new Set(linked.map((l) => l.link.videoId))];
  console.log(`\n▶ Fetching YouTube metadata for ${vodIds.length} source VOD(s)…`);
  const vods = await fetchVideoMeta(vodIds);
  const missingVods = vodIds.filter((id) => !vods.has(id));
  if (missingVods.length) {
    // Reported, never silent. A VOD gone private or deleted takes its matches
    // with it, and that is a fact about the corpus, not noise.
    console.log(`  ⚠ ${missingVods.length} VOD(s) no longer resolve (private/deleted):`);
    for (const id of missingVods) {
      const n = linked.filter((l) => l.link.videoId === id).length;
      const tag = linked.find((l) => l.link.videoId === id)?.e.tag ?? '?';
      console.log(`      ${id}  ${n} match(es)  [${tag}]`);
    }
  }

  const chars = (e: TheaterEntry, side: 1 | 2): string[] =>
    ([`p${side}_char`, `p${side}_char2`, `p${side}_char3`, `p${side}_char4`] as const)
      .map((k) => (e as Record<string, unknown>)[k])
      .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      .map((c) => c.trim());

  const records: TheaterRawRecord[] = [];
  for (const { e, link } of linked) {
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

  await writeFile(OUT, JSON.stringify(records, null, 1) + '\n', 'utf8');
  console.log(`\n  → wrote raw/replayTheater.json (${records.length} record(s))`);

  // ── reconnaissance ────────────────────────────────────────────────────────
  console.log(`\n${'█'.repeat(72)}`);
  console.log('  RECONNAISSANCE — replayTheater');
  console.log('█'.repeat(72));
  console.log(`\n  catalogue (game=${INDEX.slug}):     ${catalogue.length}`);
  console.log(`  rejected by the per-entry gate:  ${wrongGame.length}`);
  console.log(`  tagged tournament matches:       ${tagged.length}`);
  console.log(`  written (VOD resolvable):        ${records.length}`);

  const malformed = linked.filter((l) => {
    const s = l.e.video_link ?? '';
    if (!s.includes('youtu.be/')) return false;
    const tail = s.split('youtu.be/')[1] ?? '';
    return tail.includes('&t=') && !tail.includes('?');
  }).length;
  const multiT = linked.filter((l) => l.link.tCount > 1).length;
  console.log(
    `\n  concatenated youtu.be/<id>&t=Ns links: ${malformed} (${pct(malformed, linked.length)}%)`,
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
