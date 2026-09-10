/**
 * Roster drift check — is data/characters.json still what Bandai Namco ships?
 *
 * WHY THIS EXISTS, AND WHY THIS REPO ESPECIALLY. A roster goes stale silently:
 * a character who is not on it fails no build and trips no assertion, they just
 * leave every match they appear in filed with one side missing.
 *
 * This is the repo that has already been caught by exactly that shape of
 * failure once. The 2026-09-02 sweep found its PATCH table 96 days stale — 258
 * replays filed under the wrong token — and nothing here could say so. When a
 * roster audit ran across all six games on 2026-09-09, this repo also turned
 * out to have the longest-unverified roster of the six: data/characters.json
 * had not been touched since 2026-07-16, and there was no gate of any kind.
 * The roster was, as it happens, correct. Nothing in the repo knew that.
 *
 * THE PAIR THIS FORMS WITH scripts/expiries.ts. This checker is CONTENT-AWARE:
 * it fires on the real event, a new id appearing in Bandai's own grid, and it
 * cannot be early or late. expiries.ts is CLOCK-ONLY: it reads a date and
 * nothing else, so no change to the site's markup can blind it. Keep both — the
 * lesson from the sibling repos is that the sophisticated check is the one that
 * goes quietly blind, and the dumb one is what actually fires.
 *
 * THE ROSTER HERE IS A LIVE SCRAPE, so `npm run data:characters` would pick a
 * new character up on its own. That is not a substitute for this check, because
 * nothing ever runs it: it is a manual command, excluded from the cron by
 * design. This is what tells you to run it.
 *
 * NETWORK, MANUAL, NEVER IN THE CRON.
 *
 * Run: npm run data:roster-check
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UNRELEASED } from './expiries';
import { discoverIds } from './tk8-site';
import type { CharacterRecord } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type State = 'CURRENT' | 'DRIFT' | 'UNVERIFIED' | 'UNREADABLE';
const verdict = (state: State, detail = ''): never => {
  if (detail) console.log(detail);
  console.log(`roster-check: ${state}`);
  process.exit(state === 'CURRENT' || state === 'UNVERIFIED' ? 0 : 1);
};

async function main(): Promise<void> {
  const local = JSON.parse(
    await readFile(join(ROOT, 'data/characters.json'), 'utf8'),
  ) as CharacterRecord[];
  const localIds = new Set(local.map((c) => c.id));
  const gated = new Set(UNRELEASED.map((u) => u.id));

  let ids: string[];
  try {
    ids = await discoverIds();
  } catch (e) {
    const msg = (e as Error).message;
    // "discovery looks broken" is the grid yielding almost nothing — markup
    // drift, where no verdict about OUR roster would mean anything. A transport
    // failure is simply "nothing was checked". Different colours, on purpose.
    const unreadable = /discovery looks broken/i.test(msg);
    return void verdict(
      unreadable ? 'UNREADABLE' : 'UNVERIFIED',
      `${unreadable ? '✖' : '!'} ${msg}`,
    );
  }

  const upstream = new Set(ids);
  const missing = [...upstream].filter((id) => !localIds.has(id) && !gated.has(id)).sort();
  const extra = [...localIds].filter((id) => !upstream.has(id)).sort();
  const held = [...upstream].filter((id) => gated.has(id)).sort();

  console.log(
    `  ${upstream.size} id(s) in the official grid · ${localIds.size} in characters.json`,
  );
  if (gated.size)
    console.log(`  ${gated.size} announced and gated in UNRELEASED: ${[...gated].join(', ')}`);
  if (held.length)
    console.log(`  ${held.length} now paged upstream while still gated: ${held.join(', ')}`);

  if (!missing.length && !extra.length)
    return void verdict('CURRENT', '✓ roster matches the official character index');

  const lines = ['✖ roster has drifted from tk8.tekken-official.jp', ''];
  for (const id of missing)
    lines.push(
      `  MISSING  ${id} — in the official grid, not in data/characters.json.`,
      `           The roster is scraped, so the fix is short: add --char-${id} to`,
      `           design/handoff/tokens.css and the same hex to accents in`,
      `           app/app.config.ts, then run \`npm run data:characters\`. Add the release`,
      `           patch to data/patchBoundaries.json with the character as its note, and`,
      `           drop any matching UNRELEASED row in scripts/expiries.ts.`,
      `           NOTE the provisional ids in UNRELEASED are guesses; "${id}" is the real`,
      `           one, because the site is what decides.`,
    );
  for (const id of extra)
    lines.push(
      `  EXTRA    ${id} — in data/characters.json, not in the official grid.`,
      `           Usually an id Bandai Namco renamed. Confirm before deleting anything:`,
      `           records already reference this id, and data:characters would drop it.`,
    );
  verdict('DRIFT', lines.join('\n'));
}

await main();
