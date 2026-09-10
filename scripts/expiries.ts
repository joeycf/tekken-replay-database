/**
 * Self-expiring gates — things the DATA can tell us are due, rather than things
 * a human has to remember.
 *
 * WHY THIS FILE EXISTS HERE AT ALL, AND WHY IT ARRIVED LAST. Four of the six
 * sibling repos have had this gate for months; Tekken and 2XKO did not, and a
 * 2026-09-09 roster audit across all six is what surfaced the hole. This repo
 * had the longest-unverified roster of the six — data/characters.json had not
 * been touched since 2026-07-16 — and nothing in it could have said so.
 *
 * That is not a hypothetical here. This is the repo the patch-table sweep of
 * 2026-09-02 caught 96 days stale, with 258 replays filed under the wrong
 * token, because nothing was watching. A roster goes stale the same silent way:
 * a character who is not on the roster does not fail a build or trip an
 * assertion, they just leave every match they appear in filed with one side
 * missing.
 *
 * THE SEVERITY DESIGN, matching the siblings — read before "fixing" anything:
 *
 *   scripts/characters.ts  (manual roster run)  → exits 1 on a missing token
 *   .github/workflows/…    (daily cron)         → a FINAL step, AFTER commit,
 *                                                 push and the deploy smoke
 *                                                 check, that exits 1
 *
 * The cron step is deliberately LAST and deliberately failing. A hard exit
 * earlier would stop the daily refresh, which is strictly worse than the thing
 * it warns about: a day of stale data costs more than a day of a character
 * filed under no accent. So the data gets committed, pushed and smoke-checked
 * first, and only then does the run go red.
 *
 * THE RED WORKFLOW AND THE exit 1 ARE THE DESIGN, NOT A BUG. Clear them by
 * doing the work below — never by deleting the check.
 *
 * Run: npm run data:expiries   (tsx scripts/expiries.ts --check)
 */

import type { Expiry } from '../types/index';

/**
 * Characters that are ANNOUNCED but not yet playable.
 *
 * A row here is what turns a future release into a due expiry instead of
 * something someone has to diary. `releases` is the date the row FIRES.
 *
 * THE IDS BELOW ARE PROVISIONAL, AND THAT IS SAFE BECAUSE OF HOW THIS REPO
 * WORKS. Unlike the hand-authored sibling rosters, scripts/characters.ts
 * DISCOVERS ids live from Bandai Namco's own site (images/character/<id>/), so
 * the real id is whatever tk8.tekken-official.jp says on release day — not
 * whatever is typed here. These rows exist to fire a dated reminder; the scrape
 * settles the spelling. Tekken ids use UNDERSCORES (`armor_king`, `devil_jin`,
 * `miary_zo`), so the guesses follow that convention.
 *
 * WINDOW OPEN, NOT WINDOW CLOSE. Both windows below are QUARTERS. Firing early
 * costs one dismissed warning; firing at the close of a three-month window
 * could mean a character shipped in October and nothing said so until December.
 * (The CotW repo fires at window CLOSE for the opposite and equally correct
 * reason: SNK announces to the MONTH, and a month-long red run gets muted.
 * Match the rule to the granularity, never copy the sibling's number.)
 *
 * WHAT COVERS THE GAP between a window opening and a release is
 * `npm run data:roster-check`, which diffs Bandai's own character index against
 * data/characters.json and fires on the real event — a new id appearing on the
 * site. This date row is the backstop for when that is unreachable.
 *
 * PROVENANCE. Steam's "TEKKEN 8 - Season 3 Pass" (appid 4129110) enumerates the
 * whole pass verbatim, including the unreleased slots:
 *   "4 Additional playable characters
 *      - Kunimitsu            (shipped 2026-05-28, patch 3.01)
 *      - Bob                  (shipped 2026-08-19, patch 3.02)
 *      - Roger Jr. (Oct-Dec 2026)
 *      - Yujiro Hanma (Jan-Mar 2027)
 *    1 Additional battle stage
 *      - SUBSEA LOCKDOWN (Jan-Mar 2027)
 *    *Content will be fully available by 3/31/2027."
 * So the pass is four characters, two shipped, two pending — there is no fifth
 * Season 3 slot and no Season 4 announcement. Verified NOT playable on
 * 2026-09-09: a case-insensitive search of the live tk8.tekken-official.jp
 * character index returns zero hits for "roger" and zero for "yujiro"/"hanma",
 * against 42 image ids present.
 */
export const UNRELEASED: { id: string; releases: string; note?: string }[] = [
  {
    id: 'roger_jr',
    releases: '2026-10-01',
    note:
      'Season 3 pass character #3, window OCTOBER–DECEMBER 2026; this row fires at window ' +
      'OPEN. Id provisional — the scrape decides. Bandai Namco scheduled his full gameplay ' +
      'reveal trailer for EVO France on 2026-10-11, so a release date should be public ' +
      'shortly after that; re-date this row to the day once it is, rather than leaving a ' +
      'quarter-wide window in place.',
  },
  {
    id: 'yujiro',
    releases: '2027-01-01',
    note:
      'Season 3 pass character #4, window JANUARY–MARCH 2027; fires at window OPEN. Yujiro ' +
      "Hanma, revealed at Combo Breaker 2026 and announced on the official site's own news " +
      'feed (2026.05.25 「範馬 勇次郎」参戦決定！). A guest from Baki, so uploaders may write ' +
      '"Baki" or "Hanma" — check CURATED_ALIASES in scripts/characters.ts when he lands. ' +
      'The Subsea Lockdown stage ships in the same window; it is not a roster row.',
  },
];

const today = (): string => new Date().toISOString().slice(0, 10);

/** Everything whose date has now passed. Empty is the happy path. */
export function dueExpiries(asOf: string = today()): Expiry[] {
  const due: Expiry[] = [];

  for (const u of UNRELEASED) {
    if (asOf >= u.releases) {
      due.push({
        kind: 'unreleased-character',
        id: u.id,
        date: u.releases,
        action:
          `${u.id} may now be playable. If they are: confirm the real id on ` +
          `tk8.tekken-official.jp/character/ (it is whatever images/character/<id>/ says — ` +
          `this repo discovers ids, it does not declare them), add --char-<id> to ` +
          `design/handoff/tokens.css (accent from a Claude Design session — never invent one; ` +
          `the token regex accepts [a-z0-9_], so an underscore id is fine), add the same hex ` +
          `to accents in app/app.config.ts, add a comboforge entry in app/app.config.ts if ` +
          `their id does not derive, add the release patch to data/patchBoundaries.json with ` +
          `the character as its note, drop this entry from UNRELEASED, then run ` +
          `\`npm run data:characters\` and \`npm run data:parse\`. If they have NOT shipped, ` +
          `re-date this row to the announced window — do not delete it.`,
      });
    }
  }

  return due;
}

/** Human-facing block, reused by the console banner and any report surface. */
export function formatExpiries(due: Expiry[]): string {
  return due.map((e) => `- **${e.id}** (${e.kind}, due ${e.date})\n  ${e.action}`).join('\n\n');
}

// ── standalone `--check` ─────────────────────────────────────────────────────
// The workflow's LAST step. It runs after the data has been committed, pushed
// and smoke-checked, so a red run never costs a refresh — it only makes the
// pending work impossible to ignore.
const isMain = !!process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain && process.argv.includes('--check')) {
  const due = dueExpiries();
  if (!due.length) {
    console.log(`✓ no expiries due — ${UNRELEASED.length} unreleased row(s) pending`);
    process.exit(0);
  }
  console.error(`\n✖ ${due.length} EXPIRY(S) DUE — this step is designed to go red.\n`);
  for (const d of due) {
    console.error(`  ${d.id}  (${d.kind}, due ${d.date})`);
    console.error(`    ${d.action}\n`);
  }
  console.error('  Clear these by doing the work above. Never by deleting the check.');
  process.exit(1);
}
