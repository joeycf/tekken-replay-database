// POST-DEPLOY SMOKE CHECK — assert what visitors actually receive.
//
// The channel-collapse guard in parse.ts protects the REPOSITORY: it refuses to
// write a catalogue that lost a channel. Nothing protected the other end. On
// 2026-08-08 a collapsed archive was live to visitors for 21 hours on a sibling
// game, and the only reason anyone found out was a human noticing a wrong number
// on the page. This repo inherited the guard from that incident; this is its
// other half.
// This is that guard's downstream twin: it fetches the deployed payload and
// compares its record count to the one this repo just committed.
//
// WHY IT POLLS. There is no deploy step to run "after" — the workflow commits
// and pushes, and Vercel's git integration builds asynchronously off that push.
// A single fetch straight after the push would race the build and read the
// PREVIOUS deployment nearly every time. So it polls until the served count
// matches the committed one, or the deadline expires.
//
// WHY A SLOW BUILD IS NOT A FAILURE. While a deploy is in flight, production
// serves yesterday's payload — a handful of records behind, which is what a
// normal day looks like. That is measured against the SAME band the collapse
// guard uses (>10% AND >20 records), so the two gates agree on what the word
// "collapse" means. In-band at the deadline is a warning: the deploy has not
// landed yet, but what IS live is not a collapse. Out of band at the deadline
// is a hard failure: visitors are being served an archive that lost a chunk.
//
// WHY THE FETCH IS CACHE-COLD. A verification fetch that reads a cache is not a
// verification. The 2026-08-08 incident had a nine-hour false conclusion in it
// precisely because a probe was served from a cache — `no-store` plus a
// cache-busting query is not paranoia here, it is the lesson.
//
// Run it by hand any time:  npm run verify:deployed
//   SMOKE_HOST=…            probe a preview/deployment host instead of the apex
//   SMOKE_TIMEOUT_SEC=…     how long to wait for the deploy (default 900)
//   SMOKE_INTERVAL_SEC=…    seconds between attempts (default 20)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** This app's URL segment — `app/app.config.ts` game.slug. */
const SLUG = 'tekken';
/** The apex the shell owns; it edge-rewrites /<slug>/* to this project. */
const HOST = (process.env.SMOKE_HOST ?? 'https://replaydatabase.com').replace(/\/$/, '');

const TIMEOUT_SEC = Number(process.env.SMOKE_TIMEOUT_SEC ?? 900);
const INTERVAL_SEC = Number(process.env.SMOKE_INTERVAL_SEC ?? 20);

// The collapse guard's thresholds, deliberately identical (scripts/parse.ts).
// Both are required: a percentage alone punishes a small archive for ordinary
// churn, an absolute alone misses a large one bleeding slowly.
const COLLAPSE_PCT = 0.1;
const COLLAPSE_ABS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch the deployed replays.json with every cache along the path defeated. */
async function servedCount(url: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}?_cb=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      redirect: 'follow',
    });
    if (!res.ok) {
      console.log(`   … HTTP ${res.status}`);
      return null;
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      console.log('   … payload is not an array');
      return null;
    }
    return body.length;
  } catch (e) {
    console.log(`   … ${(e as Error).message}`);
    return null;
  }
}

const committed = (
  JSON.parse(readFileSync(join(ROOT, 'data', 'replays.json'), 'utf8')) as unknown[]
).length;
const url = `${HOST}/${SLUG}/data/replays.json`;

console.log(`Post-deploy smoke check — ${SLUG}`);
console.log(`  committed : ${committed.toLocaleString('en-US')} records (data/replays.json)`);
console.log(`  probing   : ${url}`);
console.log(`  waiting   : up to ${TIMEOUT_SEC}s, every ${INTERVAL_SEC}s\n`);

const deadline = Date.now() + TIMEOUT_SEC * 1000;
let last: number | null = null;

for (let attempt = 1; ; attempt++) {
  const n = await servedCount(url);
  if (n !== null) {
    last = n;
    const lost = committed - n;
    const pct = committed > 0 ? (lost / committed) * 100 : 0;
    console.log(
      `  [${attempt}] served ${n.toLocaleString('en-US')}` +
        (lost === 0
          ? '  ✓ matches'
          : `  (${lost > 0 ? '-' : '+'}${Math.abs(lost)}, ${pct.toFixed(1)}%)`),
    );
    if (n === committed) {
      console.log(`\n✓ Production serves the committed archive (${n.toLocaleString('en-US')}).`);
      process.exit(0);
    }
  }
  if (Date.now() + INTERVAL_SEC * 1000 >= deadline) break;
  await sleep(INTERVAL_SEC * 1000);
}

// Deadline. Decide on whatever production last gave us.
if (last === null) {
  console.error(
    `\n✖ Never got a readable payload from ${url} in ${TIMEOUT_SEC}s.\n` +
      '  That is not a slow deploy — the file is missing, unparseable, or the\n' +
      '  route is broken. Check the deployment and the shell rewrite.',
  );
  process.exit(1);
}

const lost = committed - last;
const collapsed = lost > COLLAPSE_ABS && lost / committed > COLLAPSE_PCT;

if (!collapsed) {
  console.warn(
    `\n⚠ Deploy has not landed within ${TIMEOUT_SEC}s.\n` +
      `  Production serves ${last.toLocaleString('en-US')} against a committed ` +
      `${committed.toLocaleString('en-US')} (${lost} behind).\n` +
      '  That is inside the collapse band, so what is live is a stale build, not\n' +
      '  a lost archive. Re-run this check, or watch the Vercel deployment.',
  );
  process.exit(0);
}

console.error(
  `\n✖ PRODUCTION IS SERVING A COLLAPSED ARCHIVE.\n` +
    `  committed ${committed.toLocaleString('en-US')} · served ${last.toLocaleString('en-US')} ` +
    `· lost ${lost.toLocaleString('en-US')} (${((lost / committed) * 100).toFixed(1)}%)\n` +
    `  Past the ${COLLAPSE_PCT * 100}% AND ${COLLAPSE_ABS}-record band after ${TIMEOUT_SEC}s, so this is\n` +
    '  not a build still in flight. Visitors are seeing this right now.\n\n' +
    '  Check the latest Vercel deployment for this project, and confirm\n' +
    '  data/replays.json in the repo is the archive you meant to publish.',
);
process.exit(1);
