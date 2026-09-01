// THE SECOND WITNESS, as a pure predicate.
//
// WHAT THIS MEASURES, and why it is worth a file. Replay Theater's catalogue is
// mostly NOT tournament footage. Of the 11,490 Tekken 8 entries this repo has
// pulled so far, 317 carry an event tag; the other 11,173 carry none, and those
// are online ranked play. They are out of INGESTION scope by design — this repo
// already tracks four channels of exactly that, and what it was worst at was
// tournament sets, which is the whole reason the index intake exists.
//
// But out of ingestion scope is not out of scope as EVIDENCE. Measured
// 2026-08-31 over that pull: 7,026 of those untagged rows point at a video THIS
// REPO HAS ALREADY PUBLISHED from a tracked channel — 46% of the corpus. Each
// one is an independent human reading of the same match: a stranger typed two
// handles and two characters into a form, and our parser read them out of the
// uploader's title. Neither saw the other.
//
// That makes this the first continuous accuracy measurement of our own title
// parser against something that is not us. Every other number in report.md is
// the pipeline grading its own homework.
//
// IT PRODUCES NO FIELD AND GATES NOTHING. A disagreement is written to
// data/theater-disagreements.json with both claims side by side; it never edits
// a record, never outranks a confident parse, and never outranks a human
// override. The catalogue is a witness, not an authority — the same posture the
// intake already takes when it resolves characters on an exact alias only and
// drops the rest to residue.
//
// EXACT ALIAS, NEVER FUZZY. The catalogue writes display names and this repo
// stores ids, so every comparison goes through the roster's own alias table
// (data/characters.json: name + extra.aliases) and the intake's own handle
// cleanup. Never reach for `matcher.one()` here — its job is to read prose out
// of a sentence, and a witness that guesses is not a witness. The same rule
// covers handles: the affix counters below EXPLAIN the misses, they never score
// them.
//
// ── THE THIRD OUTCOME, AND IN THIS REPO IT IS THE HEADLINE ─────────────────
//
// agree / disagree is not enough, because a witness that CANNOT REPRESENT the
// answer is not disagreeing with it. THE CATALOGUE HAS NO ARMOR KING. Measured
// over the join: 41 of the 42 roster ids appear somewhere in its character
// columns and `armor_king` appears zero times in 11,490 entries, while our side
// says `armor_king` on 331 of the compared sides — and on 330 of those the
// catalogue writes "King". On 20 of the 319 records it writes "King" for BOTH
// sides, which is an Armor King vs King mirror rendered as King vs King: the
// vocabulary genuinely cannot express the distinction.
//
// Scored naively those 331 sides are 331 of 334 character disagreements, and
// the first run would route 331 CORRECT records to a human. Worse, agreement
// would be permanently unreachable for exactly the rows a resolver would want
// to fix.
//
// SO THE BLIND SPOT IS DERIVED FROM THE DATA, not hardcoded. `armor_king`
// appears in this file only in comments, never in the code — the day the
// catalogue learns the name, or the day a new fighter merges into an old one,
// this reads the change instead of needing an edit. An id is unwitnessable when
// BOTH of these hold in the run's own witness:
//
//   1. the catalogue never once expresses it — no string anywhere in the pull
//      resolves to that roster id, so it has no word for it; and
//   2. where we say it, the catalogue says the SAME other id nearly every time
//      (≥ BLIND_SPOT_MIN_SIDES sides, ≥ BLIND_SPOT_CONCENTRATION of them), which
//      is the signature of a MERGE rather than of a parser that is wrong in
//      scattered ways.
//
// Condition 1 alone would be unsafe on a thin pull and the numbers say so: over
// the first 100 entries of this catalogue the observed vocabulary is 32 of 42
// roster ids, so absence would mint Asuka, Panda and Xiaoyu as blind spots. It
// is condition 2 that survives a two-page cursor morning, because a handful of
// sides cannot concentrate.
//
// The other ceiling is structural: MatchSide.characters is an ordered UNION
// (counter-picks within a set) and the catalogue carries four character columns
// per side, so a side of ours longer than `sideCap` is not something it declined
// to report — it is something it could not have said. Zero of those here; the
// longest compared side is 1. The ceiling exists for the day a set is merged.

import type { MatchVideo } from '../types/index';

/** One catalogue entry, exactly as the catalogue publishes it. Everything is
 *  nullable: this is someone else's schema and we do not get to assume. */
export interface WitnessEntry {
  id?: number;
  game?: string | null;
  video_link?: string | null;
  tag?: string | null;
  upload_date?: string | null;
  p1_name?: string | null;
  p2_name?: string | null;
  p1_char?: string | null;
  p1_char2?: string | null;
  p1_char3?: string | null;
  p1_char4?: string | null;
  p2_char?: string | null;
  p2_char2?: string | null;
  p2_char3?: string | null;
  p2_char4?: string | null;
}

/** raw/replayTheater.witness.json, written by scripts/fetch-theater.ts beside
 *  the intake dump. EVERY entry the pull saw, tagged and untagged. */
export interface WitnessFile {
  mode?: 'cursor' | 'full';
  maxEntryId?: number;
  pagesRead?: number;
  hitBound?: boolean;
  entries?: WitnessEntry[];
}

/** One row the cross-check could not settle, carrying BOTH claims. This is what
 *  reaches data/theater-disagreements.json — never a rewritten record. */
export interface Disagreement {
  videoId: string;
  field: 'players' | 'characters';
  /** 0 or 1, in our record's side order. Absent for a whole-record player miss. */
  side?: number;
  ours: string[];
  theirs: string[];
  title: string;
}

/** A roster id the catalogue has no word for, and the id it writes instead.
 *  Derived per run — see the header. */
export interface BlindSpot {
  id: string;
  /** The id the catalogue writes in its place, on `merged` of `sides` sides. */
  mergedInto: string;
  merged: number;
  sides: number;
}

export interface CrossCheckResult {
  /** Videos where exactly one catalogue entry lines up with one of our
   *  whole-video records. A video the catalogue has cut into several segments is
   *  excluded: those are the intake's own territory and there is no 1:1 claim to
   *  compare against. */
  compared: number;
  /** Catalogue entries that pointed at a video we do not hold. Not a failure —
   *  it is most of the catalogue — but the denominator of "reach". */
  unmatched: number;
  /** Videos we hold that the catalogue indexes as several segments. */
  segmented: number;
  players: {
    both: number;
    one: number;
    neither: number;
    flipped: number;
    /**
     * WHY THE MISSED SIDES MISSED, as three numbers instead of a page of rows.
     * Diagnostic only — nothing here scores anything, because substring
     * matching on handles is precisely the guessing this module refuses.
     *
     * `ours` = our handle CONTAINS theirs, so the extra text is on our side.
     * That is this repo's known `tekken-8-` leak, where "Tekken 8" from the
     * title ended up in the handle slot: 245 phantom player ids over 623 sides
     * corpus-wide, and 150 of the 156 sides in this bucket on the 2026-08-31
     * pull. It is a real defect and it is NOT this commit's to fix; counting it
     * once here is what keeps it from arriving as 150 identical rows.
     * `theirs` = their handle contains ours — a team tag the intake's own
     * ORG_PREFIXES list does not carry yet.
     * `unrelated` = neither contains the other. The only bucket worth reading
     * one row at a time.
     */
    handleAffix: { ours: number; theirs: number; unrelated: number };
  };
  characters: {
    sides: number;
    agree: number;
    subset: number;
    disagree: number;
    /** The sum of the three below — sides the catalogue could not have got
     *  right, so scoring them either way would be a lie. */
    cannotWitness: number;
    /** Our side names an id the catalogue has no word for. */
    blindSpot: number;
    /** The catalogue's own string resolves to no roster id, or it said nothing. */
    unreadable: number;
    /** Our side is longer than the catalogue's column count. */
    overCap: number;
  };
  /** The blind spots this run derived, for the report. */
  blindSpots: BlindSpot[];
  disagreements: Disagreement[];
}

/**
 * data/theater-disagreements.json — the committed home of everything the
 * cross-check knows, written ONLY by a full sweep.
 *
 * WHY THE MEASUREMENT IS COMMITTED RATHER THAN RECOMPUTED INTO report.md EVERY
 * RUN. The witness is rebuilt from scratch on each pull and holds only the pages
 * that pull read, so a cursor morning's window is a couple of hundred catalogue
 * rows and its numbers differ from yesterday's — a different WINDOW, not a
 * different corpus. Rendering those into report.md made the file change every
 * single morning whether or not any RECORD had, which defeats the cron's
 * no-change-no-commit rule from the other side and puts a deploy on the calendar
 * every day forever. It is the same failure the `_Generated` timestamp line
 * already has a suppression for, arriving through a new door — and here it also
 * defeats the cursor suppression, because that one only drops the cursor when
 * NOTHING ELSE changed.
 *
 * So: a FULL sweep measures and writes; every run renders report.md from what is
 * committed; a cursor morning prints its own reading to the console and leaves
 * the artifact alone. The block says which sweep it came from — by the
 * catalogue's own high-water entry id, which is content, not a clock.
 *
 * THE BLIND SPOTS LIVE HERE TOO, which is why this file was already an object in
 * this repo while the siblings kept a plain array. Same reason, arrived at
 * earlier: a fact about the catalogue's VOCABULARY outlives the pull that found
 * it, and a two-page morning cannot re-derive one.
 */
export interface WitnessArtifact {
  /** The reading, frozen at the last full sweep. */
  measured?: {
    /** The catalogue's high-water entry id at that sweep — names the sweep
     *  without a timestamp, so re-rendering it cannot churn the file. */
    atEntryId: number;
    compared: number;
    unmatched: number;
    segmented: number;
    players: CrossCheckResult['players'];
    characters: CrossCheckResult['characters'];
  };
  /** The last full sweep's derivation, and what a cursor run reads back as its
   *  carried set — see `carriedBlindSpots`. */
  blindSpots: BlindSpot[];
  disagreements: Disagreement[];
}

/** The YouTube id inside a catalogue link. The catalogue's submission form
 *  concatenates rather than builds — `https://youtu.be/<id>&t=554s` is a PATH
 *  with no query string — so this matches the id SHAPE explicitly and refuses
 *  anything else rather than guessing. Same regex the intake uses
 *  (scripts/fetch-theater.ts). */
const VIDEO_ID =
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/(?:live|shorts|embed)\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

/** Duo/team separators inside one catalogue name cell. Tekken is 1v1 so this
 *  almost never fires, but the cell is free text and the intake's sponsor
 *  stripper deliberately does NOT treat "|" as a delimiter. */
const NAME_SPLIT = /\s*[/&+]\s*|\s+-\s+/;

/** How many sides an id must be OUR reading of before its absence from the
 *  catalogue counts as a vocabulary gap rather than a coincidence, and how
 *  concentrated the catalogue's alternative has to be. Both are deliberately
 *  blunt: this test only has to separate "said King 330 times out of 331" from
 *  "three scattered sides on a two-page cursor morning". */
const BLIND_SPOT_MIN_SIDES = 10;
const BLIND_SPOT_CONCENTRATION = 0.9;

const charsOf = (e: WitnessEntry, side: 1 | 2): string[] =>
  ([`p${side}_char`, `p${side}_char2`, `p${side}_char3`, `p${side}_char4`] as const)
    .map((k) => (e as unknown as Record<string, unknown>)[k])
    .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.trim());

const setEq = (a: string[], b: string[]): boolean => {
  const A = new Set(a);
  const B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};
const subsetOf = (a: string[], b: string[]): boolean => a.every((x) => b.includes(x));

interface Side {
  players: string[];
  chars: string[];
}
/** One video both sides hold, with the orientation already settled. */
interface Pair {
  videoId: string;
  title: string;
  ours: Side[];
  theirs: Side[];
}

/**
 * @param witness      every entry the pull saw, tagged and untagged
 * @param committed    our published records
 * @param byAlias      the roster's exact-alias table: display name → roster id
 * @param resolveKey   the repo's player identity key (scripts/players.ts)
 * @param stripSponsor the catalogue's own handle cleanup, applied to its
 *                     strings only — ours already went through it at build
 *                     time. In this repo that is BOTH steps the index intake
 *                     runs, stripTheaterSponsor then stripOrgPrefix; passing
 *                     only the first leaves the catalogue's "Zeta Keisuke" and
 *                     our "Keisuke" looking like two people, which measured as
 *                     231 of 396 missed sides.
 * @param sideCap      how many characters the CATALOGUE can express per side
 *                     (four columns; a side of ours longer than that is one it
 *                     structurally cannot witness)
 */
export function crossCheck(
  witness: WitnessFile,
  committed: MatchVideo[],
  byAlias: Map<string, string>,
  resolveKey: (h: string) => string,
  stripSponsor: (h: string) => string,
  sideCap = 4,
  /**
   * Blind spots this repo has ALREADY derived and committed, applied on top of
   * whatever this run can derive for itself.
   *
   * WHY THEY HAVE TO PERSIST. The derivation needs BLIND_SPOT_MIN_SIDES sides of
   * evidence before it will call a vocabulary gap a vocabulary gap, and that
   * threshold is what stops a two-page cursor morning minting Asuka and Panda as
   * blind spots out of three scattered sides. But the daily run IS a two-page
   * cursor morning. Measured on this catalogue: a full sweep derives
   * `armor_king -> king` from 330 of 331 sides, while 150 entries derive nothing
   * at all and report seven Armor King sides as DISAGREEMENTS instead — correct
   * records, contested daily, in an artifact whose whole value is that its rows
   * are worth reading.
   *
   * A blind spot is a fact about the CATALOGUE'S VOCABULARY, not about a run, so
   * it outlives the pull that found it. A full sweep is authoritative and may
   * retire one (the day the catalogue learns the word, the gap is gone); a
   * cursor run can only ADD, because it has not seen enough of the catalogue to
   * say that something is absent from it.
   */
  carriedBlindSpots: BlindSpot[] = [],
): CrossCheckResult {
  // Only WHOLE-VIDEO records are comparable. Our index-intake records are
  // `${videoId}@${startSeconds}` segments built FROM this catalogue, so checking
  // them against it would be checking it against itself.
  const ours = new Map<string, MatchVideo>();
  for (const v of committed) if (!v.id.includes('@')) ours.set(v.id, v);

  const entries = witness.entries ?? [];
  const byVideo = new Map<string, WitnessEntry[]>();
  for (const e of entries) {
    const m = VIDEO_ID.exec(e.video_link ?? '');
    if (!m) continue;
    byVideo.set(m[1]!, [...(byVideo.get(m[1]!) ?? []), e]);
  }

  // THE CATALOGUE'S WHOLE VOCABULARY, read off the whole pull rather than off
  // the compared subset. A character it names once on a video we do not hold is
  // still a character it can name.
  const spoken = new Set<string>();
  for (const e of entries) {
    for (const side of [1, 2] as const) {
      for (const c of charsOf(e, side)) {
        const id = byAlias.get(c.toLowerCase());
        if (id !== undefined) spoken.add(id);
      }
    }
  }

  const r: CrossCheckResult = {
    compared: 0,
    unmatched: 0,
    segmented: 0,
    players: {
      both: 0,
      one: 0,
      neither: 0,
      flipped: 0,
      handleAffix: { ours: 0, theirs: 0, unrelated: 0 },
    },
    characters: {
      sides: 0,
      agree: 0,
      subset: 0,
      disagree: 0,
      cannotWitness: 0,
      blindSpot: 0,
      unreadable: 0,
      overCap: 0,
    },
    blindSpots: [],
    disagreements: [],
  };

  // ── pass 1: align, and nothing else ─────────────────────────────────────
  // ORIENTATION FIRST. The catalogue's p1/p2 is the submitter's reading of the
  // screen and ours is the title's; they agree on essentially every row here
  // but not by contract, and comparing characters across a swapped pair would
  // manufacture two disagreements out of none. Aligned on the HANDLES, which is
  // the field the two sources agree on most.
  //
  // Separated from the scoring because the blind spots are derived from the
  // aligned population and there is nothing to derive them from until it exists.
  const pairs: Pair[] = [];
  for (const [videoId, list] of byVideo) {
    const mine = ours.get(videoId);
    if (!mine) {
      r.unmatched++;
      continue;
    }
    // The catalogue cut this VOD into segments. Our record is the whole video,
    // so there is no single claim to compare — and these are the intake's own
    // rows anyway.
    if (list.length > 1) {
      r.segmented++;
      continue;
    }
    const e = list[0]!;
    r.compared++;

    const theirSides: Side[] = ([1, 2] as const).map((n) => ({
      players: String(e[`p${n}_name`] ?? '')
        .split(NAME_SPLIT)
        .map((x) => resolveKey(stripSponsor(x)))
        .filter(Boolean),
      chars: charsOf(e, n),
    }));
    const ourSides: Side[] = mine.sides.map((s) => ({
      players: [resolveKey(s.handle)],
      chars: s.characters,
    }));

    const score = (a: Side[], b: Side[]) =>
      a.reduce((n, s, i) => n + (s.players.some((p) => b[i]!.players.includes(p)) ? 1 : 0), 0);
    const flipped = score(ourSides, [theirSides[1]!, theirSides[0]!]) > score(ourSides, theirSides);
    if (flipped) r.players.flipped++;
    pairs.push({
      videoId,
      title: mine.title,
      ours: ourSides,
      theirs: flipped ? [theirSides[1]!, theirSides[0]!] : theirSides,
    });
  }

  // ── the blind spots, derived ────────────────────────────────────────────
  // Only ids the catalogue never once spoke are candidates; of those, only the
  // ones it consistently REPLACES with a single other id. See the header for
  // why both halves are load-bearing.
  const chances = new Map<string, number>();
  const instead = new Map<string, Map<string, number>>();
  for (const p of pairs) {
    for (let i = 0; i < 2; i++) {
      const said = p.theirs[i]!.chars.map((c) => byAlias.get(c.toLowerCase())).filter(Boolean);
      for (const c of p.ours[i]!.chars) {
        if (spoken.has(c)) continue;
        chances.set(c, (chances.get(c) ?? 0) + 1);
        const tally = instead.get(c) ?? new Map<string, number>();
        for (const id of said) tally.set(id!, (tally.get(id!) ?? 0) + 1);
        instead.set(c, tally);
      }
    }
  }
  const blind = new Map<string, BlindSpot>();
  for (const [id, sides] of chances) {
    const top = [...(instead.get(id) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])[0];
    if (!top) continue;
    if (sides < BLIND_SPOT_MIN_SIDES || top[1] / sides < BLIND_SPOT_CONCENTRATION) continue;
    blind.set(id, { id, mergedInto: top[0], merged: top[1], sides });
  }
  // A cursor pull is ADDITIVE: it keeps every carried blind spot it did not
  // re-derive, because absence of evidence in fifty entries is not evidence of
  // absence. A FULL sweep has seen the whole catalogue, so what it does not
  // re-derive is genuinely gone and is allowed to lapse.
  if (witness.mode !== 'full') {
    for (const b of carriedBlindSpots) if (!blind.has(b.id)) blind.set(b.id, b);
  }
  r.blindSpots = [...blind.values()].sort((a, b) => b.sides - a.sides);

  // ── pass 2: score ───────────────────────────────────────────────────────
  for (const p of pairs) {
    const hits = p.ours.reduce(
      (n, s, i) => n + (s.players.some((x) => p.theirs[i]!.players.includes(x)) ? 1 : 0),
      0,
    );
    for (let i = 0; i < 2; i++) {
      const mineKey = p.ours[i]!.players[0] ?? '';
      const theirKeys = p.theirs[i]!.players;
      if (theirKeys.includes(mineKey)) continue;
      if (mineKey && theirKeys.some((x) => x !== mineKey && mineKey.includes(x))) {
        r.players.handleAffix.ours++;
      } else if (mineKey && theirKeys.some((x) => x !== mineKey && x.includes(mineKey))) {
        r.players.handleAffix.theirs++;
      } else {
        r.players.handleAffix.unrelated++;
      }
    }
    if (hits === 2) r.players.both++;
    else if (hits === 1) r.players.one++;
    else {
      r.players.neither++;
      r.disagreements.push({
        videoId: p.videoId,
        field: 'players',
        ours: p.ours.flatMap((s) => s.players),
        theirs: p.theirs.flatMap((s) => s.players),
        title: p.title,
      });
    }

    for (let i = 0; i < 2; i++) {
      r.characters.sides++;
      const mineChars = p.ours[i]!.chars;
      // A SIDE OF OURS THE CATALOGUE HAS NO WORD FOR. Checked before anything
      // it said, because it does not matter what it said: it could not have
      // agreed. All 331 of this pull's `armor_king` sides land here.
      if (mineChars.some((c) => blind.has(c))) {
        r.characters.blindSpot++;
        continue;
      }
      // EXACT ALIAS ONLY. A catalogue string the roster does not know is not a
      // disagreement — it is a witness we cannot read, and guessing at it is
      // how a second witness becomes a second parser.
      const raw = p.theirs[i]!.chars;
      const resolved = raw.map((c) => byAlias.get(c.toLowerCase()));
      if (raw.length === 0 || resolved.some((x) => x === undefined)) {
        r.characters.unreadable++;
        continue;
      }
      // THE SCHEMA CEILING. The catalogue carries `sideCap` character columns;
      // MatchSide.characters is an ordered union with no such limit.
      if (mineChars.length > sideCap) {
        r.characters.overCap++;
        continue;
      }
      const theirChars = resolved as string[];
      if (setEq(mineChars, theirChars)) r.characters.agree++;
      else if (subsetOf(mineChars, theirChars) || subsetOf(theirChars, mineChars))
        r.characters.subset++;
      else {
        r.characters.disagree++;
        r.disagreements.push({
          videoId: p.videoId,
          field: 'characters',
          side: i,
          ours: mineChars,
          theirs: theirChars,
          title: p.title,
        });
      }
    }
  }
  r.characters.cannotWitness =
    r.characters.blindSpot + r.characters.unreadable + r.characters.overCap;
  return r;
}

const pct = (n: number, total: number) =>
  total === 0 ? '—' : `${((n / total) * 100).toFixed(2)}%`;

/**
 * The report.md block, in the shape of the trust tables already on that page —
 * rendered from the COMMITTED artifact rather than from this run's result. See
 * WitnessArtifact for why: byte-identical between full sweeps is what keeps a
 * quiet morning quiet. Returns nothing until a full sweep has measured once.
 */
export function formatCrossCheck(art: WitnessArtifact): string[] {
  const m = art.measured;
  if (!m || m.compared === 0) return [];
  const c = m.characters;
  const witnessable = c.agree + c.subset + c.disagree;
  const a = m.players.handleAffix;
  const affixTotal = a.ours + a.theirs + a.unrelated;
  return [
    '## Replay Theater cross-check',
    '',
    `An independent reading of **${m.compared}** of our own records, from the catalogue's`,
    'UNTAGGED entries — online replays it indexes that we also parse from a tracked',
    'channel. Neither side saw the other, so this is the only accuracy number here the',
    'pipeline did not produce about itself. It changes nothing: a disagreement is',
    'recorded in data/theater-disagreements.json with both claims, never written into',
    'a record. The catalogue does not outrank a confident parse and never outranks a',
    'human override.',
    '',
    `_Measured on the last full sweep, at catalogue entry ${m.atEntryId}. ${m.unmatched} catalogue entr(ies) point at videos_`,
    `_we do not hold; ${m.segmented} are VODs the catalogue segments, which the intake owns._`,
    '',
    '| field | population | agree | partial | disagree | cannot witness |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| players (both handles) | ${m.compared} | ${m.players.both} (${pct(m.players.both, m.compared)}) | ${m.players.one} | ${m.players.neither} | — |`,
    `| characters (per side) | ${c.sides} | ${c.agree} (${pct(c.agree, c.sides)}) | ${c.subset} | ${c.disagree} (${pct(c.disagree, c.sides)}) | ${c.cannotWitness} |`,
    '',
    `Side order differed on **${m.players.flipped}** record(s); the comparison realigns on the`,
    'handles before reading characters, so a swapped pair is not counted twice as a',
    'character disagreement.',
    '',
    // CANNOT-WITNESS IS NOT A FOOTNOTE HERE. It is the largest number in the
    // table, and a reader who takes the characters row at face value would
    // conclude the parser is 2% wrong when it is 0.02% wrong on everything the
    // catalogue is able to grade.
    ...(c.cannotWitness > 0
      ? [
          `**${c.cannotWitness}** side(s) the catalogue COULD NOT HAVE GOT RIGHT are held out of both`,
          `columns above: agreement over the ${witnessable} it can express is **${pct(c.agree, witnessable)}**.`,
          '',
          ...(art.blindSpots.length
            ? [
                'Its vocabulary has no word for these, derived from that sweep rather than declared —',
                'no string anywhere in the pull resolves to the id, and where we say it the',
                'catalogue says one particular other thing almost every time:',
                '',
                ...art.blindSpots.map(
                  (b) =>
                    `- \`${b.id}\` → the catalogue writes \`${b.mergedInto}\` instead, on ${b.merged} of the ` +
                    `${b.sides} side(s) where we say it (${pct(b.merged, b.sides)}).`,
                ),
                '',
              ]
            : []),
          ...(c.unreadable > 0 || c.overCap > 0
            ? [
                `A further ${c.unreadable} carried a character string that resolves to no roster id, and ${c.overCap}`,
                'named more characters on our side than the catalogue can hold in its four',
                'columns — MatchSide.characters is an ordered union and has no such limit.',
                '',
              ]
            : []),
        ]
      : []),
    // THE HANDLE MISSES, AS THREE NUMBERS RATHER THAN A PAGE OF ROWS. On the
    // 2026-08-31 pull 150 of the 156 in the first bucket were one known defect
    // — "Tekken 8" leaking out of the title into the handle slot, 245 phantom
    // player ids over 623 sides corpus-wide — which is a separate commit's to
    // fix. Printed one row each it would bury the nine that are worth reading.
    // Only the DERIVED numbers are emitted: the diagnosis stays here, where it
    // cannot go stale in a published artifact the day the leak is fixed.
    ...(affixTotal > 0
      ? [
          `Of the ${affixTotal} side(s) whose handles did not match, **${m.players.handleAffix.ours}** are ours carrying extra text`,
          `the catalogue does not, **${m.players.handleAffix.theirs}** are theirs carrying a team tag ORG_PREFIXES does not`,
          `list yet, and **${m.players.handleAffix.unrelated}** are genuinely different names — the only bucket worth reading one`,
          'row at a time. Reported, never scored: substring matching on handles is the kind of',
          'guessing this module refuses.',
          '',
        ]
      : []),
    ...(art.disagreements.length
      ? [
          `**${art.disagreements.length} disagreement(s)** — both claims, ours first:`,
          '',
          ...art.disagreements
            .slice(0, 25)
            .map(
              (d) =>
                `- \`${d.videoId}\`${d.side !== undefined ? ` side ${d.side}` : ''} ${d.field}: ` +
                `**${d.ours.join(', ') || '(none)'}** vs catalogue **${d.theirs.join(', ') || '(none)'}** — ${d.title.slice(0, 70)}`,
            ),
          ...(art.disagreements.length > 25 ? [`- … ${art.disagreements.length - 25} more`] : []),
          '',
        ]
      : ['No disagreements on that sweep.', '']),
  ];
}
