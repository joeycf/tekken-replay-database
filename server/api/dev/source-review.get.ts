import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only: the review worklist behind /dev/source-review. Serves the pending
// queue (data/review-queue.json, parse-regenerated) joined with whatever verdict
// data/overrides.json already carries, plus the roster for the
// character-completion form — one small payload, never the replays whale. Same
// shipping guarantees as 2XKO's and SF6's curation endpoints: 404 outside
// `nuxt dev`, and the static output carries no server at all. Read-only; the
// sibling POST writes.
//
// Shapes are restated inline rather than imported from ../../../types — the
// pipeline types deliberately never enter the Nuxt graph (types/index.ts
// header), and this endpoint only reads committed JSON.
interface QueueItem {
  id: string;
  kind: 'source-classification' | 'character-completion';
  channel: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  /** Handles the title DID state, for footage where only the characters are
   *  missing (Evo names both players and neither character). Pre-fills the
   *  completion form so a reviewer answers dropdowns, not free-text fields —
   *  and, critically, pre-fills them with the spelling players.json already
   *  uses, so a verdict cannot mint a second page for an existing player. */
  handles?: [string, string];
  reason?: string;
}

export default defineEventHandler(() => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });

  const root = process.cwd();
  const read = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;

  const queue = read<QueueItem[]>('data/review-queue.json');
  const overrides =
    read<Record<string, { channel?: string; exclude?: boolean; sides?: unknown[] }>>(
      'data/overrides.json',
    );
  const roster = read<{ id: string; name: string }[]>('data/characters.json').map((c) => ({
    id: c.id,
    name: c.name,
  }));

  // Cached HUD frames, if the extraction spike has pulled any for this id.
  // Names only — the bytes come from the sibling review-frame endpoint.
  const framesFor = (id: string): string[] => {
    const dir = join(root, 'cache/evo/frames', id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d{6}\.png$/.test(f))
      .sort()
      .map((f) => f.replace('.png', ''));
  };

  // ── disputed: does the extractor read this differently from the verdict? ───
  //
  // ONLY A BOOLEAN CROSSES THE WIRE. The extractor's actual answer is computed
  // with here and deliberately thrown away, because this page is also the
  // ground-truth labelling surface: shipping the machine's characters would put
  // a suggested answer one devtools tab away from a reviewer who is supposed to
  // be labelling blind. A flag says "look again"; it cannot say "say this".
  //
  // The comparison is the UNORDERED PAIR of character sets, the same rule
  // scripts/spike/accuracy.ts scores on, because neither side array is in a
  // trustworthy order — the extractor's is screen order, the verdict's is
  // whatever order the reviewer left the form in. Comparing positionally would
  // flag a third of the corpus as disputed purely on data-entry order.
  interface Extraction {
    id: string;
    p1: { characters: string[] };
    p2: { characters: string[] };
  }
  const extPath = join(root, 'cache/evo/extracted.json');
  const extractions = new Map<string, Extraction>();
  if (existsSync(extPath)) {
    for (const e of JSON.parse(readFileSync(extPath, 'utf8')) as Extraction[]) {
      extractions.set(e.id, e);
    }
  }
  const setKey = (xs: string[]) => [...new Set(xs)].sort().join(',');
  const pairKey = (a: string[], b: string[]) => [setKey(a), setKey(b)].sort().join(' | ');
  const disputedBy = (id: string, sides: unknown[] | undefined): boolean => {
    const e = extractions.get(id);
    if (!e || !sides || sides.length !== 2) return false;
    const [a, b] = sides as { characters?: string[] }[];
    return (
      pairKey(a?.characters ?? [], b?.characters ?? []) !==
      pairKey(e.p1.characters, e.p2.characters)
    );
  };

  return {
    roster,
    items: queue.map((q) => {
      const ov = overrides[q.id];
      const saved = ov
        ? ov.exclude === true
          ? { verdict: 'exclude' as const }
          : ov.sides
            ? { verdict: 'sides' as const, sides: ov.sides }
            : ov.channel
              ? { verdict: 'channel' as const, channel: ov.channel }
              : null
        : null;
      return {
        ...q,
        saved,
        frames: framesFor(q.id),
        disputed: saved?.verdict === 'sides' && disputedBy(q.id, ov?.sides),
      };
    }),
  };
});
