/**
 * The shared read side of Bandai Namco's official Tekken 8 site.
 *
 * EXTRACTED so scripts/characters.ts (which WRITES the roster) and
 * scripts/roster-check.ts (which only COMPARES it) enumerate ids the same way.
 * characters.ts runs its whole scrape at module load, so it cannot be imported;
 * without this module the checker would have re-implemented discovery and the
 * two copies would have drifted apart — which is the exact failure the checker
 * exists to catch.
 *
 * THE ID LIST IS ONE REQUEST, THE NAMES ARE FORTY-TWO. Discovery is split
 * deliberately: the character index carries every id in its grid, while the
 * official EN/JP names render only on each character's own page. A drift check
 * needs ids and nothing else, so it pays for one request; only the roster
 * WRITER pays for the rest.
 */

export const SITE = 'https://tk8.tekken-official.jp';
export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) tekken-replay-database roster scraper (fan project)';

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

/**
 * Every character id in the official index grid.
 *
 * IDS USE UNDERSCORES here (`armor_king`, `devil_jin`, `miary_zo`) — the site's
 * own asset-path convention, which this repo adopts verbatim rather than
 * normalising, so nothing has to translate between the two.
 *
 * The floor is a markup-drift alarm, not a roster assertion: if the grid ever
 * yields a handful of ids it means the page changed shape, and a "roster" built
 * from that would silently delete everyone.
 */
export async function discoverIds(): Promise<string[]> {
  const index = await fetchText(`${SITE}/character/`);
  const ids = [
    ...new Set([...index.matchAll(/images\/character\/([a-z0-9_]+)\/btn\.png/g)].map((m) => m[1]!)),
  ].sort();
  if (ids.length < 30) throw new Error(`roster discovery looks broken: only ${ids.length} ids`);
  return ids;
}
