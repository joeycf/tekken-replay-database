/**
 * Tournament placements — Liquipedia's Tier 1 and Tier 2 winners and
 * runners-up, written to data/tournaments.json, and the matcher that turns
 * them into `featured` + `extra.titles` on data/players.json at parse time.
 *
 * WHY THIS EXISTS. "Featured" used to mean "appears in 25+ replays", which on a
 * 25,000-replay corpus is 359 people and means nothing. A tournament result is
 * the thing the word actually describes, and Liquipedia already keeps the
 * table. This script pulls it; parse.ts applies it, so a winner with no
 * replay yet costs nothing today and is featured the day their first video
 * lands — the match is re-run on every parse against the handles it just built.
 *
 * THE ONLY LEGAL DOOR IS THE API. liquipedia.net's HTML pages sit behind a
 * Cloudflare Turnstile (a 403 to any client) and its API terms forbid automated
 * access to non-API endpoints outright. The MediaWiki API is permitted, with
 * four conditions this file honours (liquipedia.net/api-terms-of-use):
 *   - `Accept-Encoding: gzip`      — a 406 otherwise
 *   - a UA naming the project and a contact — generic UAs are blocked
 *   - ≤ 1 request / 2 s, and `action=parse` ≤ 1 per 30 s — PARSE_PACING_MS
 *   - cache; never re-request what you already have — raw/ keeps every response
 * Content is CC BY-SA 3.0: the `source` block in the file and the credit the
 * engine renders beside every title are the attribution.
 *
 * ONE CALL PER TIER. The table is Lua (Module:TournamentCard, fn=draw) and
 * renders for any game and tier through `action=parse` with the invoke as the
 * text — no page is involved, and the tier is not in the row HTML, so a tier
 * is a call. No start/end date: "since release" is every event the wiki has
 * for the game. Two tiers → two calls → ~35 s.
 *
 * WRONG-PERSON IS WORSE THAN MISSED. The matcher accepts a name only when it
 * resolves to exactly one registry id, has three or more alphanumerics, and
 * is not a fighter's name (King, Lee, Jin and Law are all people AND roster
 * entries here). Everything else is reported, never guessed, and a human
 * closes the gap in data/tournament-aliases.json — the same stance
 * scripts/players.ts takes with HANDLE_ALIASES and DISTINCT_KEYS.
 *
 * NETWORK, MANUAL, NEVER IN THE CRON. The daily refresh reads the committed
 * file; only a human runs the fetch (../sync-tournaments.sh runs all games
 * with the pacing kept across repos). Trailer contract, read by that runner:
 *
 *   tournaments: CURRENT      fetched; nothing changed
 *   tournaments: UPDATED      fetched; data/tournaments.json rewritten — review the diff
 *   tournaments: UNVERIFIED   Liquipedia unreachable or walled — nothing checked, file kept
 *   tournaments: UNREADABLE   it answered and the answer did not parse — the file is kept,
 *                             and nothing it printed is trustworthy until the parser is taught
 *   tournaments: UNSUPPORTED  this game has no Liquipedia coverage (LIQUIPEDIA_GAME is null)
 *
 * Run:  npm run data:tournaments               fetch + write (the trailer above)
 *       npm run data:tournaments -- --from-raw  re-parse raw/ offline, no network
 *       npm run data:tournaments -- --match     offline: who matched, who did not, and why
 *       tsx scripts/tournaments.ts --check      offline validator; runs inside `npm run typecheck`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveKey } from './players';
import { buildAliasMatcher, loadCharacters } from './roster';
import type { PlayerRecord, PlayerTitle } from '../types/index';

// ── game constants — the only lines that differ between sibling repos ───────

/** Liquipedia's `game=` code for Module:TournamentCard. `null` → UNSUPPORTED. */
export const LIQUIPEDIA_GAME: string | null = 't8';
/** The human-facing page the `source.url` credits. */
export const SOURCE_PAGE = 'https://liquipedia.net/fighters/Tekken_8/Tournaments';
export const TIERS: readonly number[] = [1, 2];
const UA =
  'replay-database/tekken (+https://github.com/joeycf/tekken-replay-database; devmddesign@gmail.com) data:tournaments';

// ── shared constants ────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const RAW = join(ROOT, 'raw');
export const TOURNAMENTS_FILE = join(DATA, 'tournaments.json');
export const ALIASES_FILE = join(DATA, 'tournament-aliases.json');

/** TOURNAMENTS_URL replaces the endpoint and exists for a network control
 *  (point it at an unreachable host → UNVERIFIED, file kept). */
const API = process.env.TOURNAMENTS_URL ?? 'https://liquipedia.net/fighters/api.php';
const LIMIT = 5000;
const PARSE_PACING_MS = 30_000;
const LICENCE = 'CC BY-SA 3.0';
const LICENCE_URL = 'https://creativecommons.org/licenses/by-sa/3.0/';
const WIKI = 'https://liquipedia.net';

// ── shapes ──────────────────────────────────────────────────────────────────

export interface Entrant {
  /** Display text, as the table shows it (`Dany "El Maza"`, `Tiger_Pop`). */
  name: string;
  /** Wiki page name (`Tiger_Pop`), or null when the player has no page yet. */
  page: string | null;
  flag: string | null;
  character: string | null;
}

export interface TournamentEvent {
  name: string;
  /** Wiki page name of the event, e.g. `Evo/2026/Tekken_8` — the dedupe key. */
  page: string;
  url: string;
  /** ISO end date, or null when the table carried none. */
  date: string | null;
  tier: number;
  entrants: number | null;
  prize: string | null;
  location: string | null;
  winner: Entrant | null;
  runnerUp: Entrant | null;
}

export interface TournamentsFile {
  source: {
    name: string;
    url: string;
    licence: string;
    licenceUrl: string;
    game: string;
    tiers: number[];
  };
  generatedAt: string;
  events: TournamentEvent[];
}

export interface AliasesFile {
  '//'?: string;
  /** Liquipedia entrant name or page → registry id, or null to ignore. */
  aliases: Record<string, string | null>;
}

type State = 'CURRENT' | 'UPDATED' | 'UNVERIFIED' | 'UNREADABLE' | 'UNSUPPORTED';

// ── HTML → events ───────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
export function unescapeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\u00a0/g, ' ')
    .trim();
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/** The Lua writes three shapes — `Dec 13, 2026`, `Nov 7 - 8, 2026`,
 *  `Oct 31 - Nov 1, 2026` — and the END date is the one a title carries.
 *  The last day before the year, with the last month named before it. */
export function parseEndDate(text: string): string | null {
  const t = unescapeHtml(text).replace(/\s+/g, ' ');
  const year = /(\d{4})\s*$/.exec(t)?.[1];
  if (!year) return null;
  const days = [...t.matchAll(/([A-Za-z]{3})?\s*(\d{1,2})(?=\s*[-,]|\s*$)/g)];
  if (!days.length) return null;
  let month: string | undefined;
  let day: string | undefined;
  for (const m of days) {
    if (m[1]) month = MONTHS[m[1].toLowerCase()];
    day = m[2];
  }
  if (!month || !day) return null;
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

function entrant(cell: string): Entrant | null {
  // The player anchor is the LAST one in the cell: the medal span has none and
  // a character icon, if it ever links, precedes the name.
  const anchors = [...cell.matchAll(/<a href="([^"]+)"([^>]*)>([^<]*)<\/a>/g)];
  const a = anchors[anchors.length - 1];
  if (!a) return null;
  const [, href, attrs, text] = a as unknown as [string, string, string, string];
  const name = unescapeHtml(text);
  if (!name) return null;
  const redlink = /class="new"/.test(attrs) || /redlink=1/.test(href);
  const page = redlink
    ? null
    : decodeURIComponent(
        unescapeHtml(href)
          .replace(/^\/fighters\//, '')
          .replace(/#.*$/, ''),
      );
  const flag = /class="flag"><img alt="([^"]*)"/.exec(cell)?.[1];
  const char = /class="heads-padding-right"><img alt="([^"]*)"/.exec(cell)?.[1];
  return {
    name,
    page: page || null,
    flag: flag ? unescapeHtml(flag) : null,
    character: char ? unescapeHtml(char) : null,
  };
}

const ROW =
  /<div class="divRow[^"]*">(.*?)<div class="divCell Placement FirstPlace">(.*?)<\/div><div class="divCell Placement SecondPlace">(.*?)<\/div><\/div>/gs;

/** Every row of a rendered table, tier stamped on. Rows with no event anchor
 *  are counted as `broken` rather than skipped silently — that is markup drift. */
export function parseTable(
  html: string,
  tier: number,
): { events: TournamentEvent[]; broken: number } {
  const events: TournamentEvent[] = [];
  let broken = 0;
  for (const m of html.matchAll(ROW)) {
    const [, head, first, second] = m as unknown as [string, string, string, string];
    const ev = /<b><a href="(\/fighters\/[^"]+)"[^>]*>([^<]*)<\/a><\/b>/.exec(head);
    if (!ev) {
      broken++;
      continue;
    }
    const page = decodeURIComponent(unescapeHtml(ev[1]!).replace(/^\/fighters\//, ''));
    const cell = (cls: string): string | null => {
      const r = new RegExp(`<div class="divCell ${cls} Header[^"]*">(.*?)</div>`, 's').exec(head);
      if (!r) return null;
      const txt = unescapeHtml(r[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
      return txt && txt !== '-' ? txt : null;
    };
    const entrantsText = cell('EventDetails-Left-40')?.replace(/\s*entrants?$/i, '');
    const entrants =
      entrantsText && /^\d[\d,]*$/.test(entrantsText)
        ? Number(entrantsText.replace(/,/g, ''))
        : null;
    const dateText = cell('EventDetails-Left-55');
    events.push({
      name: unescapeHtml(ev[2]!),
      page,
      url: `${WIKI}/fighters/${encodeURI(page)}`,
      date: dateText ? parseEndDate(dateText) : null,
      tier,
      entrants,
      prize: cell('EventDetails-Right-45'),
      location: cell('EventDetails-Right-60'),
      winner: entrant(first),
      runnerUp: entrant(second),
    });
  }
  return { events, broken };
}

/** Deterministic order: date desc (undated last), then name, then page — and
 *  one row per event page, the lower tier winning a (never yet seen) clash. */
export function normalizeEvents(all: TournamentEvent[]): TournamentEvent[] {
  const byPage = new Map<string, TournamentEvent>();
  for (const e of all) {
    const prev = byPage.get(e.page);
    if (!prev || e.tier < prev.tier) byPage.set(e.page, e);
  }
  return [...byPage.values()].sort(
    (a, b) =>
      (b.date ?? '').localeCompare(a.date ?? '') ||
      a.name.localeCompare(b.name) ||
      a.page.localeCompare(b.page),
  );
}

// ── the fetch ───────────────────────────────────────────────────────────────

class ApiFailure extends Error {
  constructor(
    readonly state: 'UNVERIFIED' | 'UNREADABLE',
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** undici's `err.cause` is where the real reason lives. */
const reason = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string; code?: string } };
  return err.cause?.code ?? err.cause?.message ?? err.message ?? String(e);
};

function invoke(game: string, tier: number): string {
  return `{{#invoke:Lua|invoke|module=TournamentCard|fn=draw|game=${game}|tier=${tier}|heads=3|limit=${LIMIT}}}`;
}

async function fetchTier(game: string, tier: number): Promise<string> {
  const params = new URLSearchParams({
    action: 'parse',
    format: 'json',
    formatversion: '2',
    prop: 'text',
    contentmodel: 'wikitext',
    disablelimitreport: '1',
    title: 'API',
    text: invoke(game, tier),
  });
  const url = `${API}?${params}`;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-encoding': 'gzip', accept: 'application/json' },
      });
    } catch (e) {
      last = reason(e);
      if (attempt < 3) await sleep(5_000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      const ra = Number(res.headers.get('retry-after'));
      if (attempt < 3) await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000 * attempt);
      continue;
    }
    if (res.status === 403)
      throw new ApiFailure(
        'UNVERIFIED',
        `Liquipedia answered 403 (the anti-bot wall) — nothing checked`,
      );
    if (res.status === 406)
      throw new ApiFailure(
        'UNREADABLE',
        `Liquipedia answered 406 — the gzip Accept-Encoding is missing`,
      );
    if (!res.ok) throw new ApiFailure('UNREADABLE', `Liquipedia answered HTTP ${res.status}`);
    return await res.text();
  }
  throw new ApiFailure('UNVERIFIED', `could not reach Liquipedia — ${last}`);
}

/** The rendered HTML out of the API envelope, or an UNREADABLE with the API's
 *  own error code when the invoke was refused. */
export function htmlFromEnvelope(body: string): string {
  let json: {
    parse?: { text?: string | { '*'?: string } };
    error?: { code?: string; info?: string };
  };
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    throw new ApiFailure('UNREADABLE', 'the API response is not JSON');
  }
  if (json.error)
    throw new ApiFailure('UNREADABLE', `API error ${json.error.code}: ${json.error.info}`);
  const text = json.parse?.text;
  const html = typeof text === 'string' ? text : text?.['*'];
  if (typeof html !== 'string' || !html)
    throw new ApiFailure('UNREADABLE', 'no parse.text in the API response');
  return html;
}

const rawPath = (tier: number): string => join(RAW, `liquipedia-tier${tier}.json`);

async function collect(game: string, fromRaw: boolean): Promise<TournamentEvent[]> {
  const all: TournamentEvent[] = [];
  for (const [i, tier] of TIERS.entries()) {
    let body: string;
    if (fromRaw) {
      if (!existsSync(rawPath(tier)))
        throw new ApiFailure('UNREADABLE', `--from-raw: ${rawPath(tier)} does not exist`);
      body = readFileSync(rawPath(tier), 'utf8');
    } else {
      if (i > 0) {
        console.log(`  … pacing ${PARSE_PACING_MS / 1000} s (Liquipedia: one parse per 30 s)`);
        await sleep(PARSE_PACING_MS);
      }
      console.log(`  → tier ${tier}`);
      body = await fetchTier(game, tier);
      mkdirSync(RAW, { recursive: true });
      writeFileSync(rawPath(tier), body);
    }
    const { events, broken } = parseTable(htmlFromEnvelope(body), tier);
    if (broken)
      throw new ApiFailure(
        'UNREADABLE',
        `tier ${tier}: ${broken} row(s) carry no event anchor — markup drift`,
      );
    if (events.length >= LIMIT)
      throw new ApiFailure('UNREADABLE', `tier ${tier}: hit the ${LIMIT}-row limit — raise it`);
    if (events.length === 0 && i === 0)
      throw new ApiFailure(
        'UNREADABLE',
        `tier ${tier}: zero rows — the game code or the table markup changed`,
      );
    const placed = events.filter((e) => e.winner || e.runnerUp).length;
    console.log(`    ${events.length} events, ${placed} with placements`);
    all.push(...events);
  }
  return all;
}

// ── the files ───────────────────────────────────────────────────────────────

export function readTournaments(): TournamentsFile | null {
  if (!existsSync(TOURNAMENTS_FILE)) return null;
  // Malformed is a hard stop, not a fallback: a committed file that does not
  // parse is a defect the morning run must surface, not a day of quiet misses.
  return JSON.parse(readFileSync(TOURNAMENTS_FILE, 'utf8')) as TournamentsFile;
}

export function readAliases(): AliasesFile {
  if (!existsSync(ALIASES_FILE)) return { aliases: {} };
  return JSON.parse(readFileSync(ALIASES_FILE, 'utf8')) as AliasesFile;
}

const today = (): string => new Date().toISOString().slice(0, 10);

function writeTournaments(
  game: string,
  events: TournamentEvent[],
  previous: TournamentsFile | null,
): State {
  const same = previous && JSON.stringify(previous.events) === JSON.stringify(events);
  const file: TournamentsFile = {
    source: {
      name: 'Liquipedia Fighting Games Wiki',
      url: SOURCE_PAGE,
      licence: LICENCE,
      licenceUrl: LICENCE_URL,
      game,
      tiers: [...TIERS],
    },
    generatedAt: same ? previous.generatedAt : today(),
    events,
  };
  const text = `${JSON.stringify(file, null, 2)}\n`;
  if (previous && same && readFileSync(TOURNAMENTS_FILE, 'utf8') === text) return 'CURRENT';
  writeFileSync(TOURNAMENTS_FILE, text);
  return same ? 'CURRENT' : 'UPDATED';
}

// ── the matcher — pure, run by parse.ts on every parse ──────────────────────

export type UnmatchedReason =
  'no-match' | 'ambiguous' | 'roster-collision' | 'too-short' | 'team' | 'ignored';

export interface Placement {
  name: string;
  page: string | null;
  /** The events this name placed in, most recent first. */
  titles: PlayerTitle[];
}

export interface MatchOutcome {
  /** registry id → titles, in event-date order. */
  matched: Map<string, PlayerTitle[]>;
  /** How each matched name resolved — `alias`, `page`, or the display-name rules. */
  via: Map<string, { name: string; rule: string }[]>;
  /** Matched through a display-name rule with no wiki page behind it, or on a
   *  key of four alphanumerics or fewer — worth a human glance. */
  weak: { name: string; id: string; rule: string }[];
  unmatched: (Placement & { reason: UnmatchedReason; detail?: string })[];
  /** Alias rows whose id is not in the registry (a merge, a rename, a typo). */
  staleAliases: string[];
  /** Events with at least one placement that were read. */
  events: number;
}

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Group the file's placements by entrant identity (page when present, else
 *  display name) so a player is matched once and carries every title. */
export function placements(file: TournamentsFile | null): Placement[] {
  const by = new Map<string, Placement>();
  if (!file) return [];
  for (const e of file.events) {
    if (!e.date) continue;
    for (const [who, place] of [
      [e.winner, 1],
      [e.runnerUp, 2],
    ] as const) {
      if (!who) continue;
      const key = who.page ? `page:${who.page}` : `name:${who.name}`;
      const p = by.get(key) ?? { name: who.name, page: who.page, titles: [] };
      p.titles.push({ event: e.name, place, date: e.date, url: e.url });
      by.set(key, p);
    }
  }
  for (const p of by.values())
    p.titles.sort(
      (a, b) => b.date.localeCompare(a.date) || a.place - b.place || a.event.localeCompare(b.event),
    );
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param players   the registry as parse just built it
 * @param file      data/tournaments.json, or null when the game has none
 * @param aliases   data/tournament-aliases.json `aliases`
 * @param norm      the GAME'S identity normaliser (players.ts resolveKey here:
 *                  alphanumerics + HANDLE_ALIASES, the rule resolvePlayers merges
 *                  by) — keys are compared in identity space so a match IS the id
 * @param isRosterName  true when the text resolves to a roster character
 */
export function matchTournaments(
  players: Iterable<PlayerRecord>,
  file: TournamentsFile | null,
  aliases: Record<string, string | null>,
  norm: (s: string) => string,
  isRosterName: (s: string) => boolean,
): MatchOutcome {
  const index = new Map<string, Set<string>>();
  const ids = new Set<string>();
  const add = (key: string, id: string): void => {
    if (!key) return;
    const s = index.get(key) ?? new Set<string>();
    s.add(id);
    index.set(key, s);
  };
  for (const p of players) {
    ids.add(p.id);
    add(norm(p.handle), p.id);
    add(norm(p.id), p.id);
    for (const a of p.extra?.aliases ?? []) add(norm(a), p.id);
  }

  const out: MatchOutcome = {
    matched: new Map(),
    via: new Map(),
    weak: [],
    unmatched: [],
    staleAliases: [],
    events: file ? file.events.filter((e) => e.date && (e.winner || e.runnerUp)).length : 0,
  };
  for (const [k, v] of Object.entries(aliases))
    if (v !== null && !ids.has(v)) out.staleAliases.push(`${k} → ${v}`);

  const accept = (p: Placement, id: string, rule: string, key: string): void => {
    out.matched.set(id, [...(out.matched.get(id) ?? []), ...p.titles]);
    out.via.set(id, [...(out.via.get(id) ?? []), { name: p.name, rule }]);
    // A display-name match is weak when nothing corroborates it: the name has
    // no wiki page (the page name is the one key a wiki editor vouched for) or
    // it is four alphanumerics or fewer. Weak still features; it is also listed.
    if (rule.startsWith('name') && (!p.page || alnum(key).length <= 4))
      out.weak.push({ name: p.name, id, rule });
  };

  for (const p of placements(file)) {
    // 1. the human's word, by display name or page
    const override =
      p.name in aliases
        ? aliases[p.name]
        : p.page && p.page in aliases
          ? aliases[p.page]
          : undefined;
    if (override === null) {
      out.unmatched.push({ ...p, reason: 'ignored' });
      continue;
    }
    if (typeof override === 'string') {
      if (ids.has(override)) accept(p, override, 'alias', override);
      else
        out.unmatched.push({
          ...p,
          reason: 'no-match',
          detail: `alias → ${override} is not a registry id`,
        });
      continue;
    }
    if (/^team\b/i.test(p.name) || (p.page && /^Team_/.test(p.page))) {
      out.unmatched.push({ ...p, reason: 'team' });
      continue;
    }

    // 2..5 — the first rule whose key resolves decides; a rule that resolves
    // to several ids stops the search (never guess between people).
    const nick = /"([^"]+)"/.exec(p.name)?.[1];
    const candidates: [string, string][] = [];
    if (p.page) candidates.push(['page', p.page.replace(/_/g, ' ')]);
    if (nick) {
      candidates.push(['name-sans-nick', p.name.replace(/\s*"[^"]*"\s*/g, ' ').trim()]);
      candidates.push(['name-nick', nick]);
    }
    candidates.push(['name', p.name.replace(/_/g, ' ')]);

    let decided = false;
    let sawShort = false;
    let sawRoster = false;
    for (const [rule, text] of candidates) {
      if (!text) continue;
      const key = norm(text);
      const hits = index.get(key);
      if (!hits) continue;
      if (hits.size > 1) {
        out.unmatched.push({
          ...p,
          reason: 'ambiguous',
          detail: `${rule} "${text}" → ${[...hits].join(', ')}`,
        });
        decided = true;
        break;
      }
      if (alnum(text).length < 3) {
        sawShort = true;
        continue;
      }
      if (isRosterName(text)) {
        sawRoster = true;
        continue;
      }
      accept(p, [...hits][0]!, rule, text);
      decided = true;
      break;
    }
    if (!decided)
      out.unmatched.push({
        ...p,
        reason: sawRoster ? 'roster-collision' : sawShort ? 'too-short' : 'no-match',
        detail: sawRoster
          ? 'the name is also a fighter — add an alias row to confirm the person'
          : sawShort
            ? 'under three alphanumerics — add an alias row to confirm'
            : undefined,
      });
  }
  return out;
}

/** Stamp the outcome onto the registry: `featured: true` and `extra.titles`
 *  (deduped on event+place, most recent first). Returns how many were stamped. */
export function applyTournamentTitles(
  players: Map<string, PlayerRecord>,
  outcome: MatchOutcome,
): number {
  let n = 0;
  for (const [id, titles] of outcome.matched) {
    const p = players.get(id);
    if (!p) continue;
    const seen = new Set<string>();
    const deduped = titles
      .filter((t) => {
        const k = `${t.event}|${t.place}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date) || a.place - b.place);
    p.featured = true;
    p.extra = { ...(p.extra ?? {}), titles: deduped };
    n++;
  }
  return n;
}

/** The report.md block and the console summary, from one outcome. */
export function describeOutcome(o: MatchOutcome, registrySize: number): string[] {
  const lines: string[] = [];
  const titled = [...o.matched.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const wins = titled.reduce((n, [, t]) => n + t.filter((x) => x.place === 1).length, 0);
  lines.push(
    `${o.events} events with placements read; ${titled.length} of ${registrySize} registry players carry a title ` +
      `(${wins} wins). ${o.unmatched.length} placed names are not in the registry yet — they are featured the ` +
      `day a replay of theirs is ingested, unless listed below as needing a human.`,
    '',
  );
  if (titled.length)
    lines.push(
      '**Titled:** ' +
        titled
          .map(
            ([id, t]) =>
              `\`${id}\` ${t.filter((x) => x.place === 1).length}W/${t.filter((x) => x.place === 2).length}R`,
          )
          .join(' · '),
      '',
    );
  const need = o.unmatched.filter((u) => u.reason !== 'no-match' && u.reason !== 'ignored');
  if (need.length) {
    lines.push('**Need a human** (data/tournament-aliases.json — an id, or `null` to ignore):', '');
    for (const u of need)
      lines.push(
        `- \`${u.name}\`${u.page ? ` (page ${u.page})` : ''} — ${u.reason}${u.detail ? `: ${u.detail}` : ''}; ${u.titles.length} title(s), latest ${u.titles[0]?.event}`,
      );
    lines.push('');
  }
  if (o.weak.length) {
    lines.push('**Weak matches** (short display-name key — confirm or `null` them):', '');
    for (const w of o.weak) lines.push(`- \`${w.name}\` → \`${w.id}\` via ${w.rule}`);
    lines.push('');
  }
  const waiting = o.unmatched.filter((u) => u.reason === 'no-match');
  if (waiting.length)
    lines.push(
      `**Waiting for footage** (${waiting.length}): ` +
        waiting.map((u) => `${u.name}${u.page ? '' : ' ⁽ⁿᵒ ᵖᵃᵍᵉ⁾'}`).join(', '),
      '',
    );
  if (o.staleAliases.length)
    lines.push(`⚠ **Stale alias rows** (id not in the registry): ${o.staleAliases.join('; ')}`, '');
  return lines;
}

// ── --check: the offline validator, inside `npm run typecheck` ──────────────

export function validate(
  file: TournamentsFile | null,
  aliases: AliasesFile,
  players: PlayerRecord[],
): string[] {
  const errors: string[] = [];
  if (file) {
    if (file.source?.licence !== LICENCE) errors.push(`source.licence must be "${LICENCE}"`);
    if (LIQUIPEDIA_GAME && file.source?.game !== LIQUIPEDIA_GAME)
      errors.push(`source.game "${file.source?.game}" ≠ ${LIQUIPEDIA_GAME}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(file.generatedAt ?? ''))
      errors.push('generatedAt is not an ISO date');
    const seen = new Set<string>();
    const sorted = normalizeEvents(file.events);
    file.events.forEach((e, i) => {
      const at = `events[${i}] ${e.page}`;
      if (!e.name || !e.page || !e.url) errors.push(`${at}: name, page and url are required`);
      if (seen.has(e.page)) errors.push(`${at}: duplicate event page`);
      seen.add(e.page);
      if (!TIERS.includes(e.tier))
        errors.push(`${at}: tier ${e.tier} is not one of ${TIERS.join(',')}`);
      if (e.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(e.date))
        errors.push(`${at}: date "${e.date}" is not ISO`);
      if ((e.winner || e.runnerUp) && !e.date)
        errors.push(`${at}: a placed event must carry a date`);
      for (const who of [e.winner, e.runnerUp])
        if (who && !who.name) errors.push(`${at}: an entrant has no name`);
      if (sorted[i]?.page !== e.page)
        errors.push(
          `${at}: events are not in canonical order (date desc, name) — rerun data:tournaments`,
        );
    });
  }
  const ids = new Set(players.map((p) => p.id));
  const names = new Set<string>();
  for (const p of placements(file)) {
    names.add(p.name);
    if (p.page) names.add(p.page);
  }
  for (const [k, v] of Object.entries(aliases.aliases ?? {})) {
    if (!names.has(k))
      errors.push(`aliases: "${k}" is not an entrant name or page in tournaments.json`);
    if (v !== null && !ids.has(v)) errors.push(`aliases: "${k}" → unknown player id "${v}"`);
  }
  return errors;
}

// ── main ────────────────────────────────────────────────────────────────────

const verdict = (state: State, detail = ''): never => {
  if (detail) console.log(detail);
  console.log(`tournaments: ${state}`);
  process.exit(state === 'UNREADABLE' ? 1 : 0);
};

const readPlayers = (): PlayerRecord[] =>
  existsSync(join(DATA, 'players.json'))
    ? (JSON.parse(readFileSync(join(DATA, 'players.json'), 'utf8')) as PlayerRecord[])
    : [];

async function rosterTest(): Promise<(s: string) => boolean> {
  const matcher = buildAliasMatcher(await loadCharacters());
  return (s) => matcher.find(s).length > 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--check')) {
    const errors = validate(readTournaments(), readAliases(), readPlayers());
    if (errors.length) {
      console.error(
        `✖ tournaments --check: ${errors.length} problem(s)\n` +
          errors.map((e) => `  ${e}`).join('\n'),
      );
      process.exit(1);
    }
    console.log(
      `✓ tournaments --check: ${readTournaments()?.events.length ?? 0} events, ${Object.keys(readAliases().aliases ?? {}).length} alias rows`,
    );
    return;
  }
  if (argv.includes('--match')) {
    const players = readPlayers();
    const o = matchTournaments(
      players,
      readTournaments(),
      readAliases().aliases,
      resolveKey,
      await rosterTest(),
    );
    console.log(describeOutcome(o, players.length).join('\n'));
    return;
  }

  if (!LIQUIPEDIA_GAME)
    return void verdict('UNSUPPORTED', '! this game has no Liquipedia coverage — nothing to fetch');
  const previous = readTournaments();
  let events: TournamentEvent[];
  try {
    events = normalizeEvents(await collect(LIQUIPEDIA_GAME, argv.includes('--from-raw')));
  } catch (e) {
    if (e instanceof ApiFailure)
      return void verdict(
        e.state,
        `${e.state === 'UNVERIFIED' ? '!' : '✖'} ${e.message}${previous ? ' — data/tournaments.json kept as it was' : ''}`,
      );
    throw e;
  }
  const state = writeTournaments(LIQUIPEDIA_GAME, events, previous);
  const placed = events.filter((e) => e.winner || e.runnerUp).length;
  const detail =
    state === 'UPDATED'
      ? `✓ ${events.length} events (${placed} placed) written to data/tournaments.json — review the diff, then \`npm run data:tournaments -- --match\``
      : `✓ ${events.length} events (${placed} placed) — unchanged`;
  verdict(state, detail);
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    console.log('tournaments: UNREADABLE');
    process.exit(1);
  });
}
