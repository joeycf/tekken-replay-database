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
// AND THE CODE VERSION (checklist 10i). The record count says which DATA is
// live and nothing about which CODE: a pin bump on unchanged data deploys a
// build whose replays.json is byte-identical to the old one, so a count-only
// check calls success on a deployment that is still building — or never built.
// scripts/emit.ts writes the engine tag it reads out of nuxt.config.ts into
// data/summary.json, and this script asserts the served summary.json carries
// the same tag. summary.json is fetched FIRST, because a wrong `game` there
// means the archive at this path belongs to another project (checklist 10h)
// and no amount of polling will fix that. The archive matching while the tag
// does not is a hard failure at the deadline, not a warning.
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
/** This app's identity — `app/app.config.ts` game.id, which summary.json carries
 *  as `game`. Never compare it with SLUG: on Tekken the two differ (tekken8 /
 *  tekken), and a slug comparison would fail a healthy deployment at once. */
const GAME_ID = 'tekken8';
/** The apex the shell owns; it edge-rewrites /<slug>/* to this project. */
const HOST = (process.env.SMOKE_HOST ?? 'https://replaydatabase.com').replace(/\/$/, '');

const TIMEOUT_SEC = Number(process.env.SMOKE_TIMEOUT_SEC ?? 900);
const INTERVAL_SEC = Number(process.env.SMOKE_INTERVAL_SEC ?? 20);

/**
 * THE ENGINE PIN, READ OUT OF nuxt.config.ts — the same strict reader
 * scripts/emit.ts uses: exactly one `github:joeycf/replay-engine#vX.Y.Z`
 * literal, or this check cannot say what "the pinned code" is and exits 1.
 */
function enginePin(): string {
  const src = readFileSync(join(ROOT, 'nuxt.config.ts'), 'utf8');
  const hits = [...src.matchAll(/github:joeycf\/replay-engine#(v\d+\.\d+\.\d+)/g)].map(
    (m) => m[1]!,
  );
  const unique = [...new Set(hits)];
  if (unique.length !== 1) {
    console.error(
      `✖ nuxt.config.ts pins ${unique.length} engine tag(s) (${unique.join(', ') || 'none'}) — ` +
        'the code-version half of this check needs exactly one (checklist 10i).',
    );
    process.exit(1);
  }
  return unique[0]!;
}
const ENGINE_PIN = enginePin();

// The collapse guard's thresholds, deliberately identical (scripts/parse.ts).
// Both are required: a percentage alone punishes a small archive for ordinary
// churn, an absolute alone misses a large one bleeding slowly.
const COLLAPSE_PCT = 0.1;
const COLLAPSE_ABS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch a deployed JSON file with every cache along the path defeated. */
async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${url}?_cb=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      redirect: 'follow',
    });
    if (!res.ok) {
      console.log(`   … HTTP ${res.status} (${url.split('/').pop()})`);
      return null;
    }
    return (await res.json()) as unknown;
  } catch (e) {
    console.log(`   … ${(e as Error).message}`);
    return null;
  }
}

const committed = (
  JSON.parse(readFileSync(join(ROOT, 'data', 'replays.json'), 'utf8')) as unknown[]
).length;

// LOCAL CONSISTENCY FIRST. A pin bump that did not re-run emit leaves
// data/summary.json saying yesterday's tag; polling production could then
// never pass, and the failure would read as a deploy problem. In the cron emit
// always runs first, so this fires for a human after a pin-only commit.
const committedEngine = (
  JSON.parse(readFileSync(join(ROOT, 'data', 'summary.json'), 'utf8')) as { engine?: string }
).engine;
if (committedEngine !== ENGINE_PIN) {
  console.error(
    `✖ data/summary.json carries engine ${committedEngine ?? '(absent)'} but nuxt.config.ts pins ` +
      `${ENGINE_PIN} — a pin-only commit. Run \`npm run data:emit\` and commit data/summary.json.`,
  );
  process.exit(1);
}

const replaysUrl = `${HOST}/${SLUG}/data/replays.json`;
const summaryUrl = `${HOST}/${SLUG}/data/summary.json`;

console.log(`Post-deploy smoke check — ${SLUG}`);
console.log(
  `  committed : ${committed.toLocaleString('en-US')} records (data/replays.json) on ${ENGINE_PIN}`,
);
console.log(`  probing   : ${replaysUrl}`);
console.log(`  waiting   : up to ${TIMEOUT_SEC}s, every ${INTERVAL_SEC}s\n`);

const deadline = Date.now() + TIMEOUT_SEC * 1000;
let last: number | null = null;
let lastEngine: string | null = null;

for (let attempt = 1; ; attempt++) {
  // summary.json FIRST, because the base-path failure makes every other reading
  // meaningless: a wrong `game` means the archive at that path belongs to another
  // project, and comparing counts against it would be comparing two games.
  const summary = (await getJson(summaryUrl)) as { game?: string; engine?: string } | null;
  if (summary && typeof summary.game === 'string' && summary.game !== GAME_ID) {
    console.error(
      `\n✖ THE DEPLOYMENT AT ${HOST}/${SLUG}/ IS NOT THIS GAME.\n` +
        `  summary.json says game "${summary.game}"; this project is "${GAME_ID}".\n\n` +
        '  This is the copied-env failure (checklist 10h): NUXT_APP_BASE_URL carried over from\n' +
        "  another project, so the build mounted at that game's base path. Nothing about the\n" +
        '  deployment looks wrong — it builds, it renders, the JSON parses — and polling longer\n' +
        '  will never make it true.\n\n' +
        `  Fix NUXT_APP_BASE_URL (/${SLUG}/) and NUXT_PUBLIC_SITE_URL on Production AND Preview,\n` +
        '  then redeploy.',
    );
    process.exit(1);
  }
  if (summary && typeof summary.engine === 'string') lastEngine = summary.engine;

  const body = await getJson(replaysUrl);
  if (body !== null && !Array.isArray(body)) console.log('   … payload is not an array');
  if (Array.isArray(body)) {
    const n = body.length;
    last = n;
    const lost = committed - n;
    const pct = committed > 0 ? (lost / committed) * 100 : 0;
    const enginesAgree = lastEngine === ENGINE_PIN;
    console.log(
      `  [${attempt}] served ${n.toLocaleString('en-US')} · engine ${lastEngine ?? '(absent)'}` +
        (lost === 0 && enginesAgree
          ? '  ✓ matches'
          : lost === 0
            ? ''
            : `  (${lost > 0 ? '-' : '+'}${Math.abs(lost)}, ${pct.toFixed(1)}%)`),
    );
    if (n === committed && enginesAgree) {
      console.log(
        `\n✓ Production serves the committed archive (${n.toLocaleString('en-US')}) on ${ENGINE_PIN}.`,
      );
      process.exit(0);
    }
    if (n === committed && !enginesAgree) {
      // The records match and the CODE does not. This is exactly the case 10i
      // was written from, and it is why a count-only check claimed success on a
      // deployment that was still building.
      console.log(
        `   … the archive matches but the deployment is on engine ${lastEngine ?? '(absent)'}, ` +
          `not ${ENGINE_PIN} — a build still in flight, or a pin that never deployed.`,
      );
    }
  }
  if (Date.now() + INTERVAL_SEC * 1000 >= deadline) break;
  await sleep(INTERVAL_SEC * 1000);
}

// Deadline. Decide on whatever production last gave us.
if (last === null) {
  console.error(
    `\n✖ Never got a readable payload from ${replaysUrl} in ${TIMEOUT_SEC}s.\n` +
      '  That is not a slow deploy — the file is missing, unparseable, or the\n' +
      '  route is broken. Check the deployment and the shell rewrite.',
  );
  process.exit(1);
}

// THE DEADLINE VERDICT ON THE CODE VERSION. The archive matches and the engine
// does not: the data landed, so this is not "a deploy that has not landed" — it
// is a deployment that is not on the pinned code (checklist 10i), or a
// summary.json that never learned the pin. A hard failure, not a warning: a
// warning that exits 0 is a success gate, and this is an assertion.
if (last === committed && lastEngine !== ENGINE_PIN) {
  console.error(
    `\n✖ STALE BUILD: production serves the committed archive but engine ` +
      `${lastEngine ?? 'absent from summary.json'}, not ${ENGINE_PIN}.\n` +
      `  The records are right and the CODE is not — a build still in flight after ${TIMEOUT_SEC}s,\n` +
      '  or a pin that never deployed. Check the latest Vercel deployment for this project and\n' +
      '  re-run this check once it is live.',
  );
  process.exit(1);
}

const lost = committed - last;
const collapsed = lost > COLLAPSE_ABS && lost / committed > COLLAPSE_PCT;

if (!collapsed) {
  console.warn(
    `\n⚠ Deploy has not landed within ${TIMEOUT_SEC}s.\n` +
      `  Production serves ${last.toLocaleString('en-US')} against a committed ` +
      `${committed.toLocaleString('en-US')} (${lost} behind), on engine ` +
      `${lastEngine ?? 'absent from summary.json'} against the pinned ${ENGINE_PIN}.\n` +
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
