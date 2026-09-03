/**
 * THE CURSOR DELTA HOLDS ONLY WHAT IS NEWER THAN THE CURSOR.
 *
 * The daily pull walks the feed from page 1 and stops after two clean pages,
 * so the pages it read always hold the newest hundred-odd entries whether or
 * not any of them is new. Until 2026-09-02 the tagged dump was cut from that
 * whole window, which made the first unattended cron morning read "rebuilt
 * from a cursor delta — 0 of 16 tagged" on a day with one new entry, and the
 * 16 moved with the walk length (10 on a two-page pull an hour earlier). A
 * rebuild of already-committed rows costs nothing under add-only, but it
 * mislabels a quiet morning and prints a window-sized number into a file the
 * cron commits.
 *
 * In cursor mode an entry is part of the delta only if its id is above the
 * committed cursor. An entry with no id is KEPT: add-only makes a spurious
 * rebuild harmless, while a dropped entry would wait for the next full sweep.
 * A full sweep returns everything, exactly as before.
 */
export function newerThanCursor<T extends { id?: number | null }>(
  entries: T[],
  cursorMode: boolean,
  cursorAt: number,
): T[] {
  if (!cursorMode) return entries;
  return entries.filter((e) => typeof e.id !== 'number' || e.id > cursorAt);
}
