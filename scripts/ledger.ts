/**
 * The redirect ledger's one rule about chains, shared by the writer (parse.ts)
 * and the gate (redirects.ts) so the two cannot disagree about where a row
 * should land.
 *
 * Pure: no file is read and nothing runs on import. redirects.ts cannot be
 * imported for this, because it reads the ledger and exits at top level.
 */

// Where a retired id's redirect should land: follow the ledger until it reaches
// a live player. null when the trail ends in an id that is neither live nor
// redirected (the player left the corpus outright), or loops.
export function successor(id: string, live: Set<string>, led: Record<string, string>): string | null {
  const seen = new Set<string>();
  let at = id;
  while (!live.has(at)) {
    if (seen.has(at) || led[at] === undefined) return null;
    seen.add(at);
    at = led[at];
  }
  return at;
}

/**
 * The ledger parse.ts writes: every row carried on to the live id it now means.
 *
 * A merge target can itself be merged later (x → y, then y → z). Keeping a row
 * only while its destination is live DROPPED x → y at that point instead of
 * carrying it on to z, and x's indexed URL went 404; redirects.ts --drift
 * refused the commit, so the cron held its data until a person retargeted the
 * row by hand (Tekken, 2026-10-12, when `xcc` flipped to `x-c-c`). The retarget
 * is mechanical, so it happens here.
 *
 * Dropped, as before: a row whose trail dead-ends (the player left the corpus,
 * so the redirect would land on a 404), one that loops, and one that resolves to
 * itself (a spelling that won its id back — Vercel serves a self-redirect as a
 * loop). A row whose SOURCE is live is kept on purpose: that is a merge that
 * stopped happening, and the drift gate asks a person about it.
 */
export function retargetLedger(
  proposed: Record<string, string>,
  live: Set<string>,
): Record<string, string> {
  const out: [string, string][] = [];
  for (const [from, to] of Object.entries(proposed)) {
    const next = successor(to, live, proposed);
    if (next !== null && next !== from) out.push([from, next]);
  }
  return Object.fromEntries(out.sort(([a], [b]) => a.localeCompare(b)));
}
