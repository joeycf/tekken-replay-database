/**
 * Keep retired player URLs alive.
 *
 * Merging two spellings of one player deletes a page. Every player profile is
 * PRERENDERED and listed in sitemap.xml (nuxt.config.ts seeds the routes;
 * replay-engine/modules/static-artifacts.ts writes the sitemap), so a retired id
 * is an indexed URL that becomes a hard 404 — replay-engine's players/[id].vue
 * throws createError({ statusCode: 404 }) the moment the registry has no entry.
 *
 * There is no redirect layer anywhere on this platform. This is it.
 *
 * THE DESTINATION MUST BE RELATIVE. The shell rewrites /tekken/:path* to this
 * deployment (replay-database-shell/vercel.json), so an absolute destination
 * would answer a request for replaydatabase.com with a Location pointing at
 * tekken-replay-database.vercel.app and throw the visitor off the real site. A
 * leading-slash destination resolves against whatever origin the browser is on,
 * which is the shell's.
 *
 * MANUAL, not part of the cron. The retired set only changes when a person edits
 * scripts/players.ts, and vercel.json is build configuration — the daily data
 * commit has no business touching it.
 *
 * Run: npm run data:redirects        (--check to verify without writing)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/tekken';

interface Redirect {
  source: string;
  destination: string;
  permanent: boolean;
}

const check = process.argv.includes('--check');

// Read the LEDGER, never recompute from the corpus: the retired spellings are
// gone from data/videos.json by the time this runs, and an id whose last record
// was deleted upstream still needs its redirect. parse.ts maintains it.
const ledger = JSON.parse(
  await readFile(join(ROOT, 'data', 'player-redirects.json'), 'utf8'),
) as Record<string, string>;

const playerRedirects: Redirect[] = Object.entries(ledger)
  .map(([from, to]) => ({
    source: `${BASE}/players/${from}`,
    destination: `${BASE}/players/${to}`,
    permanent: true,
  }))
  .sort((a, b) => a.source.localeCompare(b.source));

const cfgPath = join(ROOT, 'vercel.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as {
  redirects?: Redirect[];
  [k: string]: unknown;
};

// Everything that is NOT a generated player redirect is hand-authored and kept
// verbatim — the "/" → "/tekken" entry lives here too.
const manual = (cfg.redirects ?? []).filter((r) => !r.source.startsWith(`${BASE}/players/`));
const next = [...manual, ...playerRedirects];

const before = JSON.stringify(cfg.redirects ?? []);
const after = JSON.stringify(next);

if (check) {
  if (before === after) {
    console.log(`✓ vercel.json carries all ${playerRedirects.length} player redirect(s)`);
    process.exit(0);
  }
  console.error(
    `✖ vercel.json is out of date — ${playerRedirects.length} player redirect(s) expected.\n` +
      '  Run `npm run data:redirects`. Until then, every merged player URL 404s.',
  );
  process.exit(1);
}

cfg.redirects = next;
await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

console.log(
  `✓ vercel.json — ${manual.length} hand-authored redirect(s) kept, ` +
    `${playerRedirects.length} player redirect(s) generated`,
);
for (const r of playerRedirects) console.log(`    ${r.source}  →  ${r.destination}`);
