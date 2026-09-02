// Diff data/patchBoundaries.json against the wavu.wiki patch table.
//
// WHY THIS EXISTS. scripts/patches.ts validates the table's SHAPE — folded
// tokens, release order, every row inside a season, no future dates — and
// nothing validated its CONTENT. On 2026-09-02 the table was found 96 days
// stale: 3.02 (Bob) had shipped on 2026-08-19 and 258 replays sat filed under
// 3.01, every row well-formed, every gate green. SF6 has data:versions and
// Tōkon has data:patch-check for exactly this; Tekken had no command that could
// have noticed. This is that command.
//
// THE SOURCE is the wikitext of wavu's "Patches (Tekken 8)" page, through the
// MediaWiki API — one request that returns the revision id, its timestamp and
// the content. The page IS the table (one row per X.YY.ZZ release, its date in
// the same cell), so the check is a regex, a fold and a set comparison. Not
// the rendered HTML, which a skin change restyles; not Cargo, which on wavu
// holds frame data only; and not list=allpages&apprefix=Version, which mixes
// Tekken 7's 2.09, 2.10 and 3.30 into the list and would invent a 2.09 into
// S2. The page is edited on patch day and otherwise not at all, so a moved
// revid is itself the signal; the stamp is printed, never persisted
// (data/source-pins.json belongs to the cron, and this script is manual-only).
//
// THE FOLD is the JSON header's own rule made mechanical: wavu rows group by
// X.YY; the line's start is its earliest listed release; its sub-releases
// other than .00 are the row's `includes` (omitted when empty — 2.08 lists .01
// only, 3.00 lists .01 and .02, a .00-only line carries no key). Two cases are
// the repo's grammar rather than drift, and print as ⓘ:
//   · a season opener starts at the season boundary, not on wavu's date. An
//     opener is keyed on the TABLE side — row.start === season.start, the rule
//     patches.ts already enforces — never guessed from wavu's date. The two can
//     disagree by a day in either direction (3.02.01 is Aug 19 PDT and Aug 20
//     CEST), and guessing would nest a new season's opener into the old
//     season and report two false ~.
//   · a line whose major digit has no season yet. Pasting its row before the
//     season is declared builds clean and nests it under the open season.
//
// Everything else is drift and exits 1: + on wavu and not here, ~ a date that
// differs, - here and on no wavu line, ⚠ a sub-release the row's `includes`
// does not list. The last one is deliberately not informational: a hotfix on
// the newest line is the only record of that hotfix, and a checker that said
// CURRENT while it was missing would be this table's staleness again.
//
// A ROW THE REGEX CANNOT READ IS A HARD FAILURE (Tōkon's lesson, learned when a
// title format changed under it): an unreadable row is indistinguishable from
// a patch that never shipped, so the script refuses to report the rest. A
// network failure is the opposite — cannot-verify is not drift — so it warns
// and exits 0, SF6's policy, because the weekly wrapper runs four repos in a
// row and a wiki outage must not read as drift.
//
// NETWORK, MANUAL, NEVER IN THE CRON. The daily refresh reaches only its own
// intakes (YouTube, the Replay Theater index); a wiki outage is not a data
// error and must never redden a run that produced correct data. The last line
// printed is always one of `patch-check: CURRENT|DRIFT|UNVERIFIED|UNREADABLE`,
// so the wrapper never greps prose.
//
// The rules are exported as pure functions and driven from scripts/e2e.ts on
// a synthetic fixture (the freshness.ts precedent); only upstream() touches
// the network, and only the isMain block prints.
//
// Run: npm run data:patch-check

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PatchBoundary, SeasonBoundary } from '../types/index';

const API = 'https://wavu.wiki/w/api.php';
const PAGE = 'Patches (Tekken 8)';
const QUERY =
  '?action=query&prop=revisions&titles=Patches_(Tekken_8)' +
  '&rvprop=ids|timestamp|content&rvslots=main&formatversion=2&format=json';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) tekken-replay-database patch-table check (fan project)';

/** One version cell: `| <big>[[Version 3.02.01|3.02.01]]</big> <br> 2026-08-19`.
 *  Verified on all 32 rows, including 2.06.02's stray space after `<big>` —
 *  the row that silently breaks any regex written against the others. */
const ROW =
  /^\|\s*<big>\s*\[\[Version (\d+\.\d+\.\d+)\|[^\]]*\]\]\s*<\/big>\s*<br\s*\/?>\s*(\d{4}-\d{2}-\d{2})\s*$/;
/** Any cell line that links a Version page. One of these that ROW does not
 *  read is a template change, and a template change must fail, not skip. */
const VERSION_LINK = /^\|.*\[\[Version /;
/** 32 rows today. Below this the page is not the table any more, and the
 *  honest report is "unreadable", not "every patch removed". */
export const ROW_FLOOR = 28;

export interface WavuRow {
  /** X.YY.ZZ as wavu names it */
  version: string;
  /** the cell's date, verbatim */
  start: string;
  /** 1-based line in the wikitext, for the failure message */
  line: number;
}

/** One X.YY line after the fold — the shape of a patchBoundaries.json row. */
export interface FoldedLine {
  version: string;
  /** the line's earliest listed release */
  start: string;
  /** every wavu row on the line, date order */
  subs: { version: string; start: string }[];
  /** subs other than .00 — the row's `includes` */
  includes: string[];
}

export interface Finding {
  glyph: '+' | '~' | '-' | '⚠' | 'ⓘ';
  text: string;
  /** indented under the line: the paste-ready row or `includes` */
  detail?: string[];
  fatal: boolean;
}

export interface DiffSummary {
  upstreamRows: number;
  upstreamLines: number;
  upstreamNewest: FoldedLine | null;
  tableRows: number;
  tableNewest: PatchBoundary | null;
}

/** Every version cell in the wikitext, page order (newest first).
 *  Throws on a Version link the regex cannot read, naming the line, and on a
 *  row count below the floor. `floor` is a parameter only so e2e can drive
 *  the rules on a six-row fixture; the CLI never passes one. */
export function parseWavu(wikitext: string, floor = ROW_FLOOR): WavuRow[] {
  const rows: WavuRow[] = [];
  const lines = wikitext.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const m = ROW.exec(text);
    if (m) {
      rows.push({ version: m[1]!, start: m[2]!, line: i + 1 });
    } else if (VERSION_LINK.test(text)) {
      throw new Error(
        `line ${i + 1} links a Version page but is not a row this script can read: ${JSON.stringify(text.trim())}`,
      );
    }
  }
  if (rows.length < floor) {
    throw new Error(
      `only ${rows.length} version row(s) read (floor ${floor}) — the page is not the table any more`,
    );
  }
  return rows;
}

/** Group X.YY.ZZ rows into X.YY lines, oldest line first. */
export function foldWavu(rows: WavuRow[]): FoldedLine[] {
  if (rows.length === 0) throw new Error('nothing to fold: no wavu rows');
  const byLine = new Map<string, WavuRow[]>();
  for (const r of rows) {
    const key = r.version.slice(0, r.version.lastIndexOf('.'));
    const group = byLine.get(key) ?? [];
    group.push(r);
    byLine.set(key, group);
  }
  const folded: FoldedLine[] = [];
  for (const [version, group] of byLine) {
    const subs = [...group]
      .sort((a, b) => a.start.localeCompare(b.start) || a.version.localeCompare(b.version))
      .map(({ version: v, start }) => ({ version: v, start }));
    folded.push({
      version,
      start: subs[0]!.start,
      subs,
      includes: subs.map((s) => s.version).filter((v) => !v.endsWith('.00')),
    });
  }
  return folded.sort((a, b) => a.start.localeCompare(b.start));
}

const pasteRow = (version: string, start: string, includes: string[]): string =>
  `{ "version": ${JSON.stringify(version)}, "start": ${JSON.stringify(start)}` +
  (includes.length ? `, "includes": ${JSON.stringify(includes)}` : '') +
  ' }';

/** The table against the folded wavu lines. Throws on a table row without a
 *  version or start — shape is patches.ts's job, but a row this cannot key
 *  would otherwise read as "invented". */
export function diffTekken(
  table: PatchBoundary[],
  seasons: SeasonBoundary[],
  folded: FoldedLine[],
): { findings: Finding[]; summary: DiffSummary } {
  for (const p of table) {
    if (typeof p?.version !== 'string' || typeof p.start !== 'string')
      throw new Error(`patchBoundaries.json row without a version/start: ${JSON.stringify(p)}`);
  }
  if (seasons.length === 0) throw new Error('seasonBoundaries.json is empty');

  const findings: Finding[] = [];
  const ours = new Map(table.map((p) => [p.version, p]));
  const theirs = new Map(folded.map((f) => [f.version, f]));
  const seasonStarts = new Map(seasons.map((s) => [s.start, s.season]));
  const maxSeason = Math.max(...seasons.map((s) => s.season));

  for (const line of folded) {
    const first = line.subs[0]!;
    const major = Number(line.version.split('.')[0]);
    const row = ours.get(line.version);

    // The major digit is the season on every row so far. A line past the last
    // declared season is either the next opener or wavu's mistake; either way
    // its row cannot be pasted as-is, because a start with no season to nest
    // in falls into the open season.
    if (major > maxSeason) {
      findings.push({
        glyph: 'ⓘ',
        text: `${line.version} — no season ${major} in seasonBoundaries.json — opener? Declare S${major} (and close S${maxSeason}) before adding the row.`,
        fatal: false,
      });
    }

    if (!row) {
      const start = major > maxSeason ? `<the S${major} boundary once declared>` : line.start;
      findings.push({
        glyph: '+',
        text: `${line.version} (${line.start}) — on wavu, missing from patchBoundaries.json`,
        detail: [
          pasteRow(line.version, start, line.includes) +
            (major > maxSeason
              ? `   // start = the S${major} boundary once declared; wavu says ${line.start}`
              : ''),
        ],
        fatal: true,
      });
      continue;
    }

    // Openers are keyed on the table side: the row starts ON a season start.
    const openerOf = seasonStarts.get(row.start);
    if (openerOf !== undefined) {
      findings.push({
        glyph: 'ⓘ',
        text: `${line.version} opener: table ${row.start} (S${openerOf} start); wavu's first listed release is ${first.version}, ${first.start}`,
        fatal: false,
      });
    } else if (row.start !== line.start) {
      findings.push({
        glyph: '~',
        text: `${line.version} — we say ${row.start}, wavu's first release is ${first.version}, ${line.start}`,
        fatal: true,
      });
    }

    // includes, both directions. .00 is never listed and never an error.
    const listed = new Set(row.includes ?? []);
    const onLine = new Set(line.subs.map((s) => s.version));
    for (const sub of line.subs) {
      if (sub.version.endsWith('.00') || listed.has(sub.version)) continue;
      findings.push({
        glyph: '⚠',
        text: `${line.version} includes — wavu lists ${sub.version} (${sub.start}), the row does not`,
        detail: [`"includes": ${JSON.stringify(line.includes)}`],
        fatal: true,
      });
    }
    for (const token of row.includes ?? []) {
      if (onLine.has(token)) continue;
      findings.push({
        glyph: '-',
        text: `${line.version} includes ${JSON.stringify(token)} — in patchBoundaries.json, on no wavu row of that line (invented?)`,
        fatal: true,
      });
    }
  }

  for (const row of table) {
    if (theirs.has(row.version)) continue;
    findings.push({
      glyph: '-',
      text: `${row.version} (${row.start}) — in patchBoundaries.json, on no wavu line (invented?)`,
      fatal: true,
    });
  }

  return {
    findings,
    summary: {
      upstreamRows: folded.reduce((n, f) => n + f.subs.length, 0),
      upstreamLines: folded.length,
      upstreamNewest: folded.at(-1) ?? null,
      tableRows: table.length,
      tableNewest: table.at(-1) ?? null,
    },
  };
}

/** err.message plus its cause: undici says only "fetch failed" and keeps the
 *  ECONNREFUSED/ENOTFOUND a reader wants on err.cause. */
const reason = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
};

interface Upstream {
  wikitext: string;
  revid: number;
  timestamp: string;
}

/** The single request. PATCH_CHECK_URL replaces the api.php endpoint and
 *  exists only for the network control (point it at an unreachable host). */
async function upstream(): Promise<Upstream> {
  const url = `${process.env.PATCH_CHECK_URL ?? API}${QUERY}`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`wavu responded ${res.status}`);
  const body = (await res.json()) as {
    query?: {
      pages?: {
        title?: string;
        missing?: boolean;
        revisions?: {
          revid?: number;
          timestamp?: string;
          slots?: { main?: { content?: string } };
        }[];
      }[];
    };
  };
  const page = body.query?.pages?.[0];
  if (!page || page.missing) throw new Error(`wavu has no page "${PAGE}" (moved?)`);
  const rev = page.revisions?.[0];
  const wikitext = rev?.slots?.main?.content;
  if (!rev?.revid || !rev.timestamp || typeof wikitext !== 'string' || wikitext.length === 0)
    throw new Error('wavu returned no revision content (API shape changed?)');
  return { wikitext, revid: rev.revid, timestamp: rev.timestamp };
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const readJson = <T>(p: string): T =>
    JSON.parse(readFileSync(join(root, 'data', p), 'utf8')) as T;
  // Read directly, not via loadPatchTable(): that exits on a shape error and
  // would report "malformed" as "drifted". Shape is the validator's job.
  const seasons = readJson<SeasonBoundary[]>('seasonBoundaries.json');
  const { patches } = readJson<{ patches: PatchBoundary[] }>('patchBoundaries.json');

  const up = await upstream().catch((err: unknown) => {
    // Cannot-verify is not drift. Say so plainly and leave the run green.
    console.warn(`⚠ patch table NOT verified — ${reason(err)}`);
    console.log('patch-check: UNVERIFIED');
    process.exit(0);
  });

  let result: ReturnType<typeof diffTekken>;
  try {
    result = diffTekken(patches, seasons, foldWavu(parseWavu(up.wikitext)));
  } catch (err: unknown) {
    console.error(`✖ NOT readable — ${reason(err)}  (wavu "${PAGE}" rev ${up.revid})`);
    console.error('  Refusing to report on the rest. A wavu row this script cannot read is');
    console.error('  indistinguishable from a patch that never shipped, and a local row without a');
    console.error('  version/start cannot be keyed at all. Fix whichever the message names;');
    console.error('  nothing about the table is known until then.');
    console.log('patch-check: UNREADABLE');
    process.exit(1);
  }

  const { findings, summary } = result;
  const newest = summary.upstreamNewest;
  console.log(`checked against wavu "${PAGE}" rev ${up.revid} (${up.timestamp})`);
  console.log(
    `upstream: ${summary.upstreamRows} rows, folded to ${summary.upstreamLines} lines, newest ` +
      (newest ? `${newest.version} (${newest.subs[0]!.version}, ${newest.start})` : 'none'),
  );
  console.log(
    `table:    ${summary.tableRows} rows, newest ` +
      (summary.tableNewest
        ? `${summary.tableNewest.version} (${summary.tableNewest.start})`
        : 'none'),
  );

  const info = findings.filter((f) => !f.fatal);
  const drift = findings.filter((f) => f.fatal);
  if (info.length) {
    console.log('');
    for (const f of info) console.log(`  ${f.glyph} ${f.text}`);
  }

  if (drift.length === 0) {
    console.log(
      `\n✓ patch table matches wavu — ${summary.upstreamLines} lines, dates identical after the opener rule, includes identical after the .00 rule`,
    );
    console.log('patch-check: CURRENT');
  } else {
    console.error(`\n✖ patch table has drifted from wavu (${drift.length}):\n`);
    for (const f of drift) {
      console.error(`  ${f.glyph} ${f.text}`);
      for (const d of f.detail ?? []) console.error(`      ${d}`);
    }
    console.error(
      '\nAdd or correct the row in data/patchBoundaries.json, then `npm run data:parse` —\n' +
        'not `data:emit`: this repo stores patchVersion on each record, so only a re-parse\n' +
        'refiles the replays under the corrected window. A new season opener also needs\n' +
        'its seasonBoundaries.json row first; the opener starts on the season boundary.\n',
    );
    console.log('patch-check: DRIFT');
    process.exit(1);
  }
}
