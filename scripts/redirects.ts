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

import { execFileSync } from 'node:child_process';
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

/**
 * THE LEDGER ONLY EVER KNEW ABOUT MERGES, and that is not the only way a page
 * dies.
 *
 * parse.ts fills it from `mergeReport.merged` — two spellings of one player
 * resolving to one id. But an id also disappears when it simply STOPS BEING
 * PARSED: commit 367ab82 fixed a title-parse leak that had been minting a player
 * out of the game's own name and 245 ids left data/players.json at once, none of
 * them merged into anything, so nothing proposed a single redirect and this
 * check passed while 245 prerendered, sitemapped URLs turned into hard 404s.
 *
 * So --check compares the CURRENT registry against the previous one and refuses
 * any id that left it without a ledger row, whatever removed it.
 *
 * THE BASELINE IS git, because there is no other record of yesterday's registry:
 * the working tree when players.json is uncommitted (the moment a retirement is
 * about to be committed, which is when this fires for real), and HEAD~1 when it
 * is not. Both are absent in a shallow or non-git checkout, and this SAYS SO
 * rather than passing quietly — a guard that reports nothing is indistinguishable
 * from a guard that found nothing.
 */
function retiredWithoutRedirect(live: Set<string>, led: Record<string, string>): void {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let baseline: string;
  let where: string;
  try {
    // Uncommitted edits to the registry mean HEAD still holds yesterday's; with
    // a clean tree the change is already committed, so yesterday's is HEAD~1.
    const dirty = git('status', '--porcelain', '--', 'data/players.json').trim() !== '';
    where = dirty ? 'HEAD' : 'HEAD~1';
    baseline = git('show', `${where}:data/players.json`);
  } catch {
    console.log('  (no git baseline for data/players.json — retirement check skipped)');
    return;
  }
  // A retirement with no successor is a real case — a player whose last record
  // left the corpus has nowhere to redirect TO — so there is an escape hatch,
  // named the way this repo's other refusals are (`--allow-collapse`,
  // `--allow-shrink`): a person says so once, in the open.
  const allowIdx = process.argv.indexOf('--allow-retire');
  const allowed = new Set(
    allowIdx === -1 ? [] : (process.argv[allowIdx + 1] ?? '').split(',').map((x) => x.trim()),
  );
  const was = (JSON.parse(baseline) as { id: string }[]).map((p) => p.id);
  const orphaned = was.filter((id) => !live.has(id) && led[id] === undefined && !allowed.has(id));
  if (orphaned.length === 0) {
    console.log(`✓ every id retired since ${where} has a redirect (${was.length} → ${live.size})`);
    return;
  }
  console.error(
    `✖ ${orphaned.length} player id(s) left data/players.json since ${where} with no redirect:\n` +
      `    ${orphaned.slice(0, 8).join(', ')}${orphaned.length > 8 ? `, … and ${orphaned.length - 8} more` : ''}\n` +
      '  Every player profile is prerendered and in sitemap.xml, so each of these is\n' +
      '  an indexed URL that now answers 404. Add a row to data/player-redirects.json\n' +
      '  (the ledger is append-only and parse.ts carries hand-added rows forward), then\n' +
      '  run `npm run data:redirects`. If one genuinely has no successor:\n' +
      `  npx tsx scripts/redirects.ts --check --allow-retire ${orphaned.slice(0, 3).join(',')}${orphaned.length > 3 ? ',…' : ''}`,
  );
  process.exit(1);
}

// A DESTINATION THAT IS NOT A LIVE PLAYER IS A REDIRECT INTO A 404, which is
// worse than the 404 it replaces: it spends the visitor's request to arrive at
// the same place. parse.ts already refuses to write one, so this only fires on a
// hand-added row.
function destinationsExist(live: Set<string>, led: Record<string, string>): void {
  const dangling = Object.entries(led).filter(([, to]) => !live.has(to));
  if (dangling.length === 0) return;
  console.error(
    `✖ ${dangling.length} redirect(s) point at an id that is not a player:\n` +
      dangling.map(([from, to]) => `    ${from} → ${to}`).join('\n'),
  );
  process.exit(1);
}

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
  const live = new Set(
    (
      JSON.parse(await readFile(join(ROOT, 'data', 'players.json'), 'utf8')) as { id: string }[]
    ).map((p) => p.id),
  );
  destinationsExist(live, ledger);
  retiredWithoutRedirect(live, ledger);
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
