// E2E suite — Playwright-core (same launch mechanics as og.ts) against the
// generated static output. THE PHASE-4 GENERICITY AUDIT in executable form:
// Tekken exercises the engine knobs 2XKO doesn't (charactersPerSide 1, rank
// filter ON, co-occurrence OFF, default terms + /characters/* routes), so
// every check here is either "the gated surface is present with Tekken's
// data" or "the tag-fighter surface is ABSENT". Numeric expectations are
// computed Node-side from the committed data files, never hardcoded.
//
// Prereq: npm run generate       Run: npm run test:e2e

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import RANKS from '../data/ranks.json';
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
    ['/?c=kazuya', count((v) => v.sides.some((s) => s.character === 'kazuya')), 'character facet'],
    [
      '/?c=kazuya,jin&side=1',
      count((v) => ['kazuya', 'jin'].every((c) => v.sides.some((s) => s.character === c))),
      'c=a,b AND semantics; stray side=1 ignored (1v1)',
    ],
    [
      '/?mu=jin:kazuya',
      count(
        (v) =>
          (v.sides[0].character === 'jin' && v.sides[1].character === 'kazuya') ||
          (v.sides[0].character === 'kazuya' && v.sides[1].character === 'jin'),
      ),
      'matchup facet (opposing sides)',
    ],
    ['/?patch=S2', count((v) => v.season === 2), 'patch facet'],
    ['/?src=telly', count((v) => v.channel === 'telly'), 'source facet'],
    // a source fed by its own channel vs. one aggregating organizers' channels
    ['/?src=tournament', count((v) => v.channel === 'tournament'), 'source facet (aggregated)'],
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
