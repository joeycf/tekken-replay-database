// E2E suite — Playwright-core (same launch mechanics as og.ts) against the
// generated static output. THE PHASE-4 GENERICITY AUDIT in executable form:
// Tekken exercises the engine knobs 2XKO doesn't (charactersPerSide 1, rank
// filter ON, co-occurrence OFF, default terms + /characters/* routes), so
// every check here is either "the gated surface is present with Tekken's
// data" or "the tag-fighter surface is ABSENT". Numeric expectations are
// computed Node-side from the committed data files, never hardcoded.
//
// Prereq: npm run generate       Run: npm run test:e2e

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import RANKS from '../data/ranks.json';
import { DISTINCT_KEYS, idKey } from './players';
import type { CharacterRecord, MatchVideo, PlayerRecord, VideoOverride } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.vercel/output/static');

// The base the build was generated under. DETECTED, not assumed: the committed
// default is '/tekken/', but a root-based build (NUXT_APP_BASE_URL=/) is a
// legitimate local preview and the suite must pass against either. nitro's
// static presets nest the whole site under the base inside publicDir, so the
// prerendered index.html marks the base directory.
//
// Getting this wrong is not a subtle failure: the suite navigated root-relative
// paths against a '/tekken/' build for the whole of Phase 5, so every page 404'd
// and the audit gated nothing until it was noticed by hand on 2026-07-20.
function detectBase(): string {
  if (existsSync(join(OUT, 'index.html'))) return '';
  for (const name of readdirSync(OUT)) {
    if (existsSync(join(OUT, name, 'index.html'))) return `/${name}`;
  }
  throw new Error(
    `no prerendered index.html under ${OUT} — run \`npm run generate\` before \`npm run test:e2e\``,
  );
}
const BASE = detectBase();

// ── Node-side expectations: the SAME record set the site carries ─────────────
const allVideos = JSON.parse(readFileSync(join(ROOT, 'data/videos.json'), 'utf8')) as MatchVideo[];
const overrides = JSON.parse(readFileSync(join(ROOT, 'data/overrides.json'), 'utf8')) as Record<
  string,
  VideoOverride
>;
const excluded = new Set(
  Object.entries(overrides)
    .filter(([, ov]) => ov.exclude === true)
    .map(([id]) => id),
);
const videos = allVideos.filter((v) => !excluded.has(v.id));
const characters = JSON.parse(
  readFileSync(join(ROOT, 'data/characters.json'), 'utf8'),
) as CharacterRecord[];
const players = JSON.parse(readFileSync(join(ROOT, 'data/players.json'), 'utf8')) as PlayerRecord[];
const stats = JSON.parse(readFileSync(join(ROOT, 'data/stats.json'), 'utf8')) as {
  totals: { replays: number; byPatch: Record<string, number> };
  characterUsage: Record<string, number>;
};

const fmt = (n: number) => n.toLocaleString('en-US');
const count = (pred: (v: MatchVideo) => boolean) => videos.filter(pred).length;

// The rank chips the facet actually renders (engine v0.5.0 — STACK §10): the
// canonical ascending ladder intersected with the ranks PRESENT in the data,
// displayed highest-first. The engine deliberately stopped rendering the whole
// ladder — a chip that would filter to zero replays is never shown — so
// asserting RANKS.length here would re-assert the pre-v0.5.0 behavior.
const ranksPresent = new Set<string>();
for (const v of videos) for (const s of v.sides) if (s.rank) ranksPresent.add(s.rank);
const rankChipsAsc = RANKS.filter((r) => ranksPresent.has(r));
const rankChipsExpected = [...rankChipsAsc].reverse();

// ── tiny static server over the generated output ─────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
function serve(): Promise<{ at: (path: string) => string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const candidates = [join(OUT, path), join(OUT, path, 'index.html'), join(OUT, '404.html')];
    for (const file of candidates) {
      try {
        const body = readFileSync(file);
        res.writeHead(file.endsWith('404.html') && !path.endsWith('404.html') ? 404 : 200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        });
        res.end(body);
        return;
      } catch {
        /* try next */
      }
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const origin = `http://127.0.0.1:${addr.port}`;
      // Serve the static ROOT (as Vercel does) and address pages under the
      // base — never re-root the server at the base dir, which would resolve
      // the site's own absolute /<base>/_nuxt/… asset URLs to 404s.
      resolve({ at: (path: string) => `${origin}${BASE}${path}`, close: () => server.close() });
    });
  });
}

// ── minimal expect harness ───────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
function expect(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✖ ${label}`);
  }
}

async function resultCount(page: Page): Promise<number> {
  const txt = (await page.locator('[data-testid="result-count"]').first().textContent()) ?? '';
  const m = /([\d,]+)/.exec(txt);
  return m ? Number(m[1]!.replaceAll(',', '')) : -1;
}
const gotoIdle = async (page: Page, url: string) => {
  await page.goto(url, { waitUntil: 'networkidle' });
};

async function main(): Promise<void> {
  const { at, close } = await serve();
  const browser: Browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 960 } })
  ).newPage();

  // ── 0. Substrate — the union schema, checked Node-side ────────────────────
  // MatchSide.characters is an ordered UNION (every character a side played
  // across a set), not a single character. These guard the widening itself:
  // every expectation is COMPUTED from the committed data, never hardcoded, so
  // they keep meaning as the corpus grows a counter-picked record.
  console.log('\n— Substrate (union schema)');
  const emitted = JSON.parse(readFileSync(join(ROOT, 'data/replays.json'), 'utf8')) as {
    id: string;
    sides: { player: string; characters: string[] }[];
  }[];
  const emittedById = new Map(emitted.map((r) => [r.id, r]));

  // Round-trip: the substrate's union must survive into the emitted record
  // unchanged, in order. A silent re-ordering or truncation here would be
  // invisible on single-character records and wrong on every counter-pick.
  const roundTripBroken = videos.filter((v) => {
    const r = emittedById.get(v.id);
    if (!r) return true;
    return v.sides.some(
      (s, i) => s.characters.join(',') !== (r.sides[i]?.characters ?? []).join(','),
    );
  });
  expect(
    roundTripBroken.length === 0,
    `union round-trips into replays.json (${videos.length} records)`,
  );

  // Zero characters must be impossible — this is the shape an unresolved
  // charactersFromFootage record would have if one escaped the review queue.
  const emptySides = videos.filter((v) => v.sides.some((s) => s.characters.length === 0));
  expect(emptySides.length === 0, 'no record has a side with zero characters');

  // POSITIVE CONTROL: prove the emit gate above actually fires. A gate that has
  // never been observed rejecting anything is not known to be a gate.
  const rosterIds = new Set(characters.map((c) => c.id));
  const zeroRejected = (() => {
    const side = { player: 'x', characters: [] as string[] };
    return side.characters.length < 1 || !side.characters.every((c) => rosterIds.has(c));
  })();
  expect(zeroRejected, 'positive control: a zero-character side fails the emit predicate');

  // The union's own arithmetic: character appearances are the COMPUTED sum of
  // side list lengths, not records × 2. Those agree only while every side names
  // one character, so this is the check that would catch a counter-picked
  // record being counted once instead of twice.
  const usageSum = Object.values(stats.characterUsage ?? {}).reduce((a, b) => a + b, 0);
  const expectedUsage = videos.reduce(
    (n, v) => n + v.sides.reduce((m, s) => m + s.characters.length, 0),
    0,
  );
  expect(
    usageSum === expectedUsage,
    `characterUsage is the computed union sum (${usageSum} === ${expectedUsage})`,
  );

  // Every emitted character id is on the roster, across the whole union.
  const offRoster = emitted.flatMap((r) =>
    r.sides.flatMap((s) => s.characters.filter((c) => !rosterIds.has(c))),
  );
  expect(offRoster.length === 0, 'every character in every union is on the roster');

  // ── the review queue ──────────────────────────────────────────────────────
  // Pending items are footage whose characters no text states. They must be
  // visible in the queue and absent from BOTH published artifacts — a pending
  // item that leaked into replays.json would be a record with invented sides.
  const queue = JSON.parse(readFileSync(join(ROOT, 'data/review-queue.json'), 'utf8')) as {
    id: string;
    kind: string;
    channel: string;
    title: string;
    publishedAt: string;
    durationSec: number;
    handles?: [string, string];
  }[];
  const KINDS = new Set(['source-classification', 'character-completion']);
  expect(
    queue.every(
      (q) =>
        typeof q.id === 'string' &&
        q.id.length > 0 &&
        KINDS.has(q.kind) &&
        typeof q.title === 'string' &&
        /^\d{4}-\d{2}-\d{2}T/.test(q.publishedAt) &&
        q.durationSec > 0,
    ),
    `review-queue.json schema validates (${queue.length} pending)`,
  );
  // A character-completion item exists to be answered by a human or the
  // extractor, and both need the two handles the title DID state.
  expect(
    queue.every((q) => q.kind !== 'character-completion' || q.handles?.length === 2),
    'every character-completion item carries both handles',
  );
  const queuedIds = new Set(queue.map((q) => q.id));
  expect(
    allVideos.every((v) => !queuedIds.has(v.id)),
    'pending review items never reach videos.json',
  );
  expect(
    emitted.every((r) => !queuedIds.has(r.id)),
    'pending review items never reach replays.json',
  );
  const reportMd = readFileSync(join(ROOT, 'data/report.md'), 'utf8');
  const pendingLine = /Pending review: (\d+)/.exec(reportMd);
  expect(
    pendingLine !== null && Number(pendingLine[1]) === queue.length,
    `report.md pending count matches the queue (${queue.length})`,
  );

  // A charactersFromFootage channel's records exist ONLY because a sides
  // verdict was recorded, so every one of them must have an override. If this
  // fires, records are being minted from somewhere they should not be.
  const footageIntakes = new Set(
    (JSON.parse(readFileSync(join(ROOT, 'data/videos.json'), 'utf8')) as MatchVideo[])
      .map((v) => v.intake)
      .filter((k) => k === 'evoEvents'),
  );
  if (footageIntakes.size) {
    const footage = videos.filter((v) => v.intake === 'evoEvents');
    expect(
      footage.length > 0 && footage.every((v) => overrides[v.id]?.sides !== undefined),
      `every footage-read record is backed by a sides verdict (${footage.length})`,
    );
  }

  // intake survives parse: dedupe precedence needs to tell two channels apart
  // that share one public source ('tournament' aggregates the event organizers).
  const missingIntake = videos.filter((v) => !v.intake);
  expect(missingIntake.length === 0, 'every record carries its intake channel key');
  expect(
    new Set(videos.map((v) => v.intake)).size >= new Set(videos.map((v) => v.channel)).size,
    'intake is at least as discriminating as source (it must separate shared-source channels)',
  );

  // ── 1. /health — counts + provisioning paths + the active GameConfig ──────
  console.log('\n— /health');
  await gotoIdle(page, at('/health'));
  const health = (await page.textContent('body')) ?? '';
  expect(
    health.includes(fmt(videos.length)) || health.includes(String(videos.length)),
    `health shows ${videos.length} replays`,
  );
  expect(
    health.includes(String(characters.length)),
    `health shows ${characters.length} characters`,
  );
  expect(health.includes(String(players.length)), `health shows ${players.length} players`);
  expect(
    (health.match(/provided \(bundled\)/g) ?? []).length === 3,
    'registries ×3 provided (bundled)',
  );
  expect(health.includes('client-fetched (server:false)'), 'replays are client-fetched');
  expect(
    /charactersPerSide\s*1(?!\d)/.test(health.replace(/\s+/g, ' ')),
    'config: charactersPerSide 1',
  );
  expect(
    /filters\.coOccurrence\s*false/.test(health.replace(/\s+/g, ' ')),
    'config: coOccurrence false',
  );
  expect(/filters\.rank\s*true/.test(health.replace(/\s+/g, ' ')), 'config: rank true');
  expect(health.includes('God of Destruction'), 'config: ladder listed through God of Destruction');

  // ── 2. Browse — grid, gated facets, every always-on facet ─────────────────
  console.log('\n— Browse (/)');
  await gotoIdle(page, at('/'));
  await page.waitForSelector('[data-replay-id]');
  expect((await resultCount(page)) === videos.length, `result count = ${videos.length}`);
  const co = await page.locator('[data-testid="co-occurrence-toggle"]').count();
  expect(co === 0, 'co-occurrence filter is ABSENT (1v1)');
  const rankChips = (await page.locator('[data-testid="rank-chip"]').allTextContents()).map((t) =>
    t.trim(),
  );
  expect(
    rankChips.length === rankChipsExpected.length,
    `rank filter PRESENT with the ${rankChipsExpected.length} data-present ranks (ladder has ${RANKS.length})`,
  );
  expect(
    rankChips.join('|') === rankChipsExpected.join('|'),
    `rank chips render highest-first (${rankChipsExpected[0]} … ${rankChipsExpected.at(-1)})`,
  );
  // Cards represent each side with ONE CharacterBadge (aria-label = the
  // character's name) — 2 per card for 1v1, where 2XKO shows 4.
  const rosterNames = new Set(characters.map((c) => c.name));
  const firstCardBadges = await page
    .locator('[data-replay-id]')
    .first()
    .evaluate(
      (el, names) =>
        [...el.querySelectorAll('[aria-label]')].filter((n) =>
          names.includes(n.getAttribute('aria-label') ?? ''),
        ).length,
      [...rosterNames],
    );
  expect(
    firstCardBadges === 2,
    `card renders a SINGLE character badge per side (got ${firstCardBadges})`,
  );
  const thumbImgs = await page
    .locator('[data-replay-id]')
    .first()
    .locator('img[src*="i.ytimg.com"]')
    .count();
  expect(thumbImgs === 1, 'thumb derives from the YouTube id (thumb omitted from the whale file)');

  const deepLinks: [string, number, string][] = [
    [
      `/?rank=${encodeURIComponent('God of Destruction')}`,
      count((v) => v.sides.some((s) => s.rank === 'God of Destruction')),
      'rank facet',
    ],
    [
      '/?c=kazuya',
      count((v) => v.sides.some((s) => s.characters.includes('kazuya'))),
      'character facet',
    ],
    [
      '/?c=kazuya,jin&side=1',
      count((v) => ['kazuya', 'jin'].every((c) => v.sides.some((s) => s.characters.includes(c)))),
      'c=a,b AND semantics; stray side=1 ignored (1v1)',
    ],
    [
      '/?mu=jin:kazuya',
      count(
        (v) =>
          (v.sides[0].characters.includes('jin') && v.sides[1].characters.includes('kazuya')) ||
          (v.sides[0].characters.includes('kazuya') && v.sides[1].characters.includes('jin')),
      ),
      'matchup facet (opposing sides)',
    ],
    ['/?patch=S2', count((v) => v.season === 2), 'patch facet'],
    ['/?src=telly', count((v) => v.channel === 'telly'), 'source facet'],
    // a source fed by its own channel vs. one aggregating organizers' channels
    ['/?src=tournament', count((v) => v.channel === 'tournament'), 'source facet (aggregated)'],
    // the Online group chip (v0.5.5) writes the three gameplay sources as a set
    [
      '/?src=highLevel,telly,ranked',
      count((v) => ['highLevel', 'telly', 'ranked'].includes(v.channel)),
      'source group (Online set)',
    ],
    ['/?p=knee', count((v) => v.sides.some((s) => s.player === 'knee')), 'player facet'],
    [
      '/?from=2026-07-01',
      count((v) => v.publishedAt.slice(0, 10) >= '2026-07-01'),
      'date facet (from)',
    ],
  ];
  for (const [url, expected, label] of deepLinks) {
    await gotoIdle(page, at(url));
    const got = await resultCount(page);
    expect(got === expected, `${label}: ${url} → ${got} (want ${expected})`);
  }

  // source filter consolidated to Online + Tournament (v0.5.5) — per-channel chips
  // gone (the card SourceBadge still shows the real channel via spans, not buttons)
  await gotoIdle(page, at('/'));
  const srcBtns: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()),
  );
  expect(
    srcBtns.includes('Online') && srcBtns.includes('Tournament'),
    'Online + Tournament chips render',
  );
  expect(
    !srcBtns.includes('High Level') && !srcBtns.includes('Telly') && !srcBtns.includes('Ranked'),
    'per-channel source chips are consolidated away',
  );

  // ── 2b. Grouped patch facet (engine v0.6.0) ────────────────────────────────
  // The shipped flat season facet is ABSORBED: parent tokens ARE the old
  // S1/S2/S3 tokens (the ?patch=S2 deep-link row above is the legacy parity
  // anchor — same param, same exact count), children are the wavu-folded
  // patch versions from data/patchBoundaries.json.
  console.log('\n— Grouped patch facet');
  const byVersion = (ver: string) => count((v) => v.patchVersion === ver);
  await gotoIdle(page, at('/?patch=2.03'));
  expect(
    (await resultCount(page)) === byVersion('2.03'),
    `fine patch ?patch=2.03 → ${fmt(byVersion('2.03'))}`,
  );
  const mixedN = count((v) => v.season === 1) + byVersion('2.03');
  await gotoIdle(page, at('/?patch=S1,2.03'));
  expect((await resultCount(page)) === mixedN, `mixed ?patch=S1,2.03 unions to ${fmt(mixedN)}`);

  // tri-state parent + child dropdown round-trip with canonical URL collapse
  await gotoIdle(page, at('/'));
  await page.click('[data-testid="patch-group-S3"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('patch') === 'S3');
  expect(
    (await resultCount(page)) === count((v) => v.season === 3),
    'parent toggle-all → whole-season count (incl. patch-unknown records)',
  );
  expect(
    (await page.locator('[data-testid="patch-group-S3"]').getAttribute('aria-pressed')) === 'true',
    'parent aria-pressed=true when fully selected',
  );
  await page.click('[data-testid="patch-group-S3-expander"]');
  await page.click('[data-testid="patch-child-3.00"]');
  await page.waitForFunction(() =>
    (new URL(location.href).searchParams.get('patch') ?? '')
      .split(',')
      .every((t) => t !== 'S3' && t !== '3.00'),
  );
  expect(
    (await page.locator('[data-testid="patch-group-S3"]').getAttribute('aria-pressed')) === 'mixed',
    'partial selection reads aria-pressed=mixed',
  );
  expect(
    (await resultCount(page)) === byVersion('3.01'),
    'children-only URL counts only the remaining patch',
  );
  await page.click('[data-testid="patch-child-3.00"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('patch') === 'S3');
  expect(
    (await resultCount(page)) === count((v) => v.season === 3),
    're-completed era collapses back to ?patch=S3 with the season count',
  );

  // modal meta line reads "era · patch · rank · …" for fine-token replays
  await gotoIdle(page, at('/?patch=2.03'));
  await page.waitForSelector('[data-replay-id]');
  await page.locator('[data-replay-id]').first().click();
  await page.waitForTimeout(600);
  const dialogText = (await page.locator('[role="dialog"][aria-modal="true"]').innerText()) ?? '';
  expect(/S2 · 2\.03/.test(dialogText), 'modal meta line reads "S2 · 2.03 · …"');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // stats stay ERA-keyed; every emitted token is an era or declared version
  const eraRe = /^S\d+$/;
  for (const key of Object.keys(stats.totals.byPatch))
    expect(eraRe.test(key), `stats key "${key}" stays era-level`);
  const { patches: declaredPatches } = JSON.parse(
    readFileSync(join(ROOT, 'data/patchBoundaries.json'), 'utf8'),
  ) as { patches: { version: string }[] };
  const declared = new Set(declaredPatches.map((p) => p.version));
  const emittedReplays = JSON.parse(readFileSync(join(ROOT, 'data/replays.json'), 'utf8')) as {
    id: string;
    patch?: string;
  }[];
  expect(
    emittedReplays.every((r) => eraRe.test(r.patch ?? '') || declared.has(r.patch ?? '')),
    'every emitted patch token is an era key or a declared version',
  );

  // double-emit byte-identity: the standalone emitter must be deterministic
  {
    const files = [
      'data/replays.json',
      'data/stats.json',
      'data/patchGroups.json',
      // content-derived, so it must NOT move between runs — a build timestamp
      // here would commit (and deploy) on every zero-new-video day
      'data/summary.json',
    ];
    const hash = (p: string) =>
      createHash('sha256')
        .update(readFileSync(join(ROOT, p)))
        .digest('hex');
    const before = files.map(hash);
    execSync('npm run data:emit', { cwd: ROOT, stdio: 'pipe' });
    const after = files.map(hash);
    expect(
      files.every((_, i) => before[i] === after[i]),
      'double-emit: replays/stats/patchGroups/summary byte-stable across runs',
    );
  }

  // ── 3. Modal + related ─────────────────────────────────────────────────────
  console.log('\n— Video modal');
  await gotoIdle(page, at('/?c=kazuya'));
  await page.waitForSelector('[data-replay-id]');
  await page.locator('[data-replay-id]').first().click();
  await page.waitForTimeout(600);
  const modalOpen =
    (await page.locator('button[aria-label^="Play"]').count()) > 0 ||
    (await page.locator('iframe').count()) > 0;
  expect(modalOpen, 'modal opens with the lite-embed facade');
  const related =
    (await page.locator('[data-testid="related-grid"]').count()) +
    (await page.locator('[data-testid="related-list"]').count());
  expect(related > 0, 'related replays (same-matchup / shared-player) render');
  expect(new URL(page.url()).searchParams.has('v'), 'modal state lives in ?v= (shareable)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect(!new URL(page.url()).searchParams.has('v'), 'Escape closes the modal');

  // ── 4. Stats — 1v1 panel gating ────────────────────────────────────────────
  console.log('\n— /stats');
  await gotoIdle(page, at('/stats'));
  expect((await page.locator('[data-testid="usage-bars"]').count()) > 0, 'character usage renders');
  expect(
    (await page.locator('[data-testid="meta-timeline"]').count()) > 0,
    'meta-over-time renders (S1/S2/S3)',
  );
  expect(
    (await page.locator('[data-testid="synergy-matrix"]').count()) === 0,
    'synergy matrix ABSENT (duo-only)',
  );
  expect(
    (await page.locator('[data-testid="pairing-bars"]').count()) === 0,
    'pairing bars ABSENT (duo-only)',
  );
  expect((await page.locator('[data-testid="patch-chips"]').count()) > 0, 'patch selector renders');

  // ── 5. Roster + character page (default /characters/* segment) ────────────
  console.log('\n— /characters');
  await gotoIdle(page, at('/characters'));
  const rosterPortraits = await page.locator('img[src*="-portrait.webp"]').count();
  expect(
    rosterPortraits >= characters.length,
    `roster grid renders all ${characters.length} scraped portraits`,
  );

  console.log('\n— /characters/kazuya');
  await gotoIdle(page, at('/characters/kazuya'));
  const charH1 = (await page.locator('h1').first().textContent()) ?? '';
  expect(charH1.includes('Kazuya'), 'h1 renders the character name');
  const charBody = (await page.textContent('body')) ?? '';
  expect(charBody.includes('Kazuya Mishima'), 'extra strip renders the official full name');
  expect(
    (await page.locator('[data-testid="character-appearances"]').count()) > 0,
    'appearance stat renders',
  );
  const rawCharHtml = readFileSync(join(OUT, BASE, 'characters/kazuya/index.html'), 'utf8');
  expect(
    rawCharHtml.includes(`Kazuya — ${fmt(stats.characterUsage.kazuya!)} appearances`),
    'PRERENDERED title carries data-derived count (registries provided at build)',
  );

  // ComboForge cross-link (engine v0.11.0). Both branches: Law needs the id
  // override ('tekken8-marshall-law' — they file Tekken by full name), and Anna
  // is not on ComboForge at all, so her band must fall back to the game hub
  // rather than emit a deep link to nothing.
  expect(
    readFileSync(join(OUT, BASE, 'characters/law/index.html'), 'utf8').includes(
      'characterId=tekken8-marshall-law',
    ),
    'ComboForge band uses the Marshall Law id override',
  );
  const annaHtml = readFileSync(join(OUT, BASE, 'characters/anna/index.html'), 'utf8');
  expect(
    annaHtml.includes('comboforge.gg/browse?gameId=tekken8') && !annaHtml.includes('characterId='),
    'ComboForge band falls back to the hub for a character they do not carry (Anna)',
  );

  // ComboForge nav item + leaving-site dialog (engine v0.12.0). The nav link is
  // a REAL <a href> — the interstitial is a click handler, not a replacement —
  // so the raw url must survive into the prerendered HTML for crawlers.
  const navCombos = page.locator('[data-testid="nav-combos"]');
  expect((await navCombos.count()) > 0, 'nav carries the Combos item');
  expect(
    (await navCombos.first().getAttribute('href')) ===
      'https://comboforge.gg/browse?gameId=tekken8',
    'nav Combos points at this game on ComboForge',
  );
  const urlBeforeCombos = page.url();
  await navCombos.first().click();
  await page.waitForSelector('[data-testid="leaving-site-dialog"]', { timeout: 5000 });
  expect(page.url() === urlBeforeCombos, 'clicking Combos shows the dialog instead of navigating');
  expect(
    ((await page.textContent('[data-testid="leaving-site-dialog"]')) ?? '').includes('ComboForge'),
    'the dialog names the partner',
  );
  expect(
    (await page.getAttribute('[data-testid="leaving-site-continue"]', 'href')) ===
      'https://comboforge.gg/browse?gameId=tekken8',
    'the dialog continues to the same url the link carried',
  );
  await page.click('text=Stay here');
  await page.waitForSelector('[data-testid="leaving-site-dialog"]', {
    state: 'detached',
    timeout: 5000,
  });
  expect(page.url() === urlBeforeCombos, '"Stay here" closes it and stays put');

  // ── 6. Player page ─────────────────────────────────────────────────────────
  console.log('\n— /players/knee');
  await gotoIdle(page, at('/players/knee'));
  const playerH1 = (await page.locator('h1').first().textContent()) ?? '';
  expect(playerH1.includes('Knee'), 'h1 renders the player handle');
  expect(
    (await page.locator('[data-testid="player-matches"]').count()) > 0,
    'player match list renders',
  );

  // ── 7. The re-skin — Tekken tokens, engine styles untouched ───────────────
  console.log('\n— Theme (re-skin check)');
  await gotoIdle(page, at('/'));
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const h1 = document.querySelector('header') ?? document.body;
    return {
      primary: cs.getPropertyValue('--color-primary').trim(),
      secondary: cs.getPropertyValue('--color-secondary').trim(),
      bg: cs.getPropertyValue('--color-bg').trim(),
      display: cs.getPropertyValue('--font-display').trim(),
      ui: cs.getPropertyValue('--font-ui').trim(),
      accentKazuya: cs.getPropertyValue('--accent-kazuya').trim(),
      bodyFont: getComputedStyle(document.body).fontFamily,
      headerText: (h1.textContent ?? '').replace(/\s+/g, ' '),
    };
  });
  expect(tokens.primary === '#e13048', `--color-primary is Tekken crimson (${tokens.primary})`);
  expect(tokens.secondary === '#9d5cff', `--color-secondary is devil violet (${tokens.secondary})`);
  expect(tokens.bg === '#0b0b0d', `--color-bg is carbon (${tokens.bg})`);
  expect(
    tokens.display.includes('Rajdhani'),
    `--font-display is Rajdhani (${tokens.display.slice(0, 40)})`,
  );
  expect(tokens.ui.includes('Archivo'), `--font-ui is Archivo (${tokens.ui.slice(0, 40)})`);
  expect(tokens.bodyFont.includes('Archivo'), 'body actually renders in Archivo');
  expect(
    tokens.accentKazuya.toLowerCase() === '#e23b4e',
    `roster accent injected from app.config (${tokens.accentKazuya})`,
  );
  expect(/TEKKEN\s*\/\s*REPLAY/i.test(tokens.headerText), 'wordmark reads TEKKEN / REPLAY');
  const footerText = (await page.locator('footer').textContent()) ?? '';
  expect(
    footerText.includes('built with passion and love for the game'),
    'footer shows the brand tagline',
  );
  expect(
    footerText.includes('Help support the site'),
    'footer links the Buy Me a Coffee support page',
  );

  // ── 8. Inherited build artifacts ───────────────────────────────────────────
  console.log('\n— Static artifacts');
  // Placement is itself the assertion (engine v0.5.1 / STACK §10): sitemap,
  // robots and manifest land UNDER the base, while 404.html is copied to the
  // static ROOT because Vercel's 404 lookup ignores the base.
  const sitemap = readFileSync(join(OUT, BASE, 'sitemap.xml'), 'utf8');
  expect(sitemap.includes('/characters/kazuya'), 'sitemap carries character routes');
  expect(!sitemap.includes('/health'), 'sitemap excludes /health');
  expect(existsSync(join(OUT, BASE, 'robots.txt')), 'robots.txt emitted under the base');
  const four = readFileSync(join(OUT, '404.html'), 'utf8');
  expect(four.includes('No data at this route'), 'designed 404 shipped at the static root');
  const manifest = JSON.parse(readFileSync(join(OUT, BASE, 'manifest.webmanifest'), 'utf8')) as {
    name: string;
    theme_color: string;
  };
  expect(
    manifest.name === 'Tekken 8 Replay Database' && manifest.theme_color === '#E13048',
    'manifest carries Tekken identity',
  );

  // ── summary.json: the apex selector's payload (Phase 6) ───────────────────
  // Three checks emit itself cannot make, because emit can only compare the
  // payload against numbers it just derived:
  //  1. it is IN THE BUILD — the nuxt.config build:before copy is otherwise
  //     ungated (nothing in this app reads summary.json), so dropping it would
  //     pass this whole suite and 404 the selector's fetch in production;
  //  2. `updated` recomputed from the substrate HERE — the only assertion that
  //     can distinguish the newest replay's date from a BUILD timestamp, which
  //     would rewrite the file every day and defeat the cron's commit guard.
  //     The double-emit hash gate can't: two runs on the same day agree;
  //  3. identity matches the GameConfig this build actually rendered.
  const summaryPath = join(OUT, BASE, 'data/summary.json');
  expect(existsSync(summaryPath), 'summary.json shipped under the base in the generated output');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
    game: string;
    name: string;
    replays: number;
    players: number;
    characters: number;
    updated: string;
  };
  const newestReplay = videos.reduce((max, v) => (v.publishedAt > max ? v.publishedAt : max), '');
  expect(
    summary.updated === newestReplay.slice(0, 10),
    `summary.updated is the NEWEST REPLAY's date, not a build stamp (${summary.updated} vs ${newestReplay.slice(0, 10)})`,
  );
  // ── player identity ───────────────────────────────────────────────────────
  // One player, one page. idKey collapses spelling variants at parse time; this
  // asserts the result, because the failure is invisible from the site — two
  // profiles for one person both render correctly, each holding some of the
  // matches, and nothing looks broken from either.
  expect(
    players.every((p) => p.id.length > 0),
    'every player id is non-empty',
  );
  expect(
    new Set(players.map((p) => p.id)).size === players.length,
    'player ids are unique',
  );
  {
    const byKey = new Map<string, string[]>();
    for (const p of players) {
      const k = idKey(p.handle);
      byKey.set(k, [...(byKey.get(k) ?? []), p.handle]);
    }
    const undeclared = [...byKey.entries()].filter(
      ([k, hs]) => hs.length > 1 && !DISTINCT_KEYS.has(k),
    );
    expect(
      undeclared.length === 0,
      `no two players share a normalised key undeclared${
        undeclared.length
          ? ` (${undeclared
              .slice(0, 3)
              .map(([k, hs]) => `${k}: ${hs.join('/')}`)
              .join(', ')})`
          : ''
      }`,
    );
  }

  expect(
    summary.replays === videos.length &&
      summary.characters === characters.length &&
      summary.players === players.length,
    `summary counts match the substrate (${summary.replays}/${summary.characters}/${summary.players} vs ${videos.length}/${characters.length}/${players.length})`,
  );
  expect(
    manifest.name === `${summary.name} Replay Database` && summary.game === 'tekken8',
    `summary identity agrees with the rendered GameConfig (game=${summary.game}, name=${summary.name})`,
  );

  // ── observability wiring ──────────────────────────────────────────────────
  // The gate that DID NOT EXIST when the subpath cutover silently killed
  // analytics for ~10 days (found 2026-07-27; engine PLAN Phase-7 retro). The
  // cutover battery checked themes, canonicals, sitemaps and redirects, but
  // nothing ever asserted a beacon resolves, so both SDKs 404'd into the void
  // and every dashboard read zero.
  //
  // Two failure modes, both visible only on the BUILT output:
  //   1. the per-project obfuscated path Vercel bakes into the bundle
  //      ("/2eaa11be5fdac02d/script.js") — exists only on this project's own
  //      host, 404s the moment the shell proxies the page onto the apex;
  //   2. the base-STRIPPED path both SDK wrappers report — /tekken/stats
  //      arriving as /stats, colliding with 2XKO's /stats in the dashboard.
  //
  // The endpoints 404 locally (a static dir has no /view) and that is fine:
  // what is gated here is the SHAPE — which URL is asked for, and what path is
  // reported. That a proxied beacon actually LANDS is a property of Vercel's
  // routing, gated in the shell's verify-cutover.mjs against a real deployment.
  console.log('\n— observability');
  {
    const octx = await browser.newContext();
    const opage = await octx.newPage();
    const asked: string[] = [];
    opage.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (/insights|vitals/.test(p)) asked.push(p);
    });

    await gotoIdle(opage, at('/stats'));
    // both SDKs attach on idle, after networkidle has already resolved
    await opage.waitForTimeout(4000);

    const srcs = (await opage.evaluate(
      `[...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))`,
    )) as string[];
    const observability = srcs.filter((s) => /insights|vitals/.test(s));

    // must match app.config.ts game.observability.insights AND the matching
    // rewrite in the shell's vercel.json — all three move together
    expect(
      observability.includes('/tekken-insights/script.js'),
      `web analytics script src is /tekken-insights/script.js (got ${JSON.stringify(observability)})`,
    );
    // Speed Insights stays on the stable path on purpose: single-project on
    // Hobby, so its beacons must reach whichever project has it enabled
    expect(
      observability.includes('/_vercel/speed-insights/script.js'),
      `speed insights script src is /_vercel/speed-insights/script.js (got ${JSON.stringify(observability)})`,
    );
    // THE REGRESSION ITSELF: a 16-hex baked path means the explicit endpoints
    // stopped winning over VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG
    const baked = [...observability, ...asked].filter((s) => /^\/[0-9a-f]{16}\//.test(s));
    expect(baked.length === 0, `no baked per-project hash path (got ${JSON.stringify(baked)})`);
    const stray = asked.filter(
      (p) => !p.startsWith('/tekken-insights/') && !p.startsWith('/_vercel/speed-insights/'),
    );
    expect(
      stray.length === 0,
      `no insights request outside the configured prefixes (got ${JSON.stringify(stray)})`,
    );

    // the reported pageview must carry the base. The script 404s here, so the
    // queue never drains and window.vaq still holds what WOULD be sent.
    const queued = (await opage.evaluate(`JSON.stringify(window.vaq ?? [])`)) as string;
    const pageviews = (JSON.parse(queued) as [string, { route?: string; path?: string }][]).filter(
      ([kind]) => kind === 'pageview',
    );
    expect(pageviews.length > 0, `a pageview is queued (window.vaq = ${queued})`);
    const reported = pageviews[0]?.[1] ?? {};
    expect(
      reported.path === `${BASE}/stats`,
      `reported path carries the base (expected ${BASE}/stats, got ${reported.path})`,
    );
    expect(
      reported.route === `${BASE}/stats`,
      `reported route carries the base (expected ${BASE}/stats, got ${reported.route})`,
    );

    await octx.close();
  }

  await browser.close();
  close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  ✖ ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('✖ e2e failed:', err);
  process.exit(1);
});
