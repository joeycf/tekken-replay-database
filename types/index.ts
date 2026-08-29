// Pipeline-track types (plain node/tsx code — never enters the Nuxt graph, so
// the engine contract is restated where emitted shapes must mirror it, exactly
// like the 2XKO pipeline does).

/** The Replay.source contract: doubles as GameConfig.sourceChannels[].id
 *  (badge/filter). One source may be fed by SEVERAL YouTube channels —
 *  'tournament' aggregates the event organizers' channels, whose uploads are
 *  the same kind of replay regardless of who published them. */
export type SourceId = 'highLevel' | 'telly' | 'ranked' | 'tournament';

/** Per-YouTube-channel intake key: names raw/<key>.json and the coverage
 *  report's rows, so channels sharing a source stay separately auditable.
 *
 *  'evoEvents' is declared ahead of its CHANNELS entry: the review queue is
 *  typed on this union and the Evo corpus is labelled through /dev before the
 *  channel is enrolled. Until enrollment nothing fetches raw/evoEvents.json. */
export type ChannelKey =
  'highLevel' | 'telly' | 'ranked' | 'bneEsports' | 'evoEvents' | 'replayTheater';

/**
 * An INDEX source: a third-party catalogue that points AT video rather than
 * hosting it. Its entries are (videoId, startSeconds) pairs plus players,
 * characters and an event tag, so a record here is a SEGMENT of a longform VOD
 * and several records share one video. There is no channel, no uploads
 * playlist, and nothing to resolve.
 */
export interface ChannelIndex {
  /** Catalogue endpoint, paged with &page=N. */
  endpoint: string;
  /** The index's own token for this game, used as the ?game= query value. */
  slug: string;
  /** The game string each ENTRY states about itself. Checked per entry, because
   *  ?game= is a filter someone else answers and a mistagged submission arrives
   *  looking exactly like a real one. */
  gameLabel: string;
  /** Entries per page. Theirs, not ours — the API ignores per_page/limit. */
  pageSize: number;
  /** ms between requests — politeness, not rate-limit avoidance. */
  pacingMs: number;
}

export interface ChannelConfig {
  /** Raw-dump key / report row (unique per YouTube channel). */
  id: ChannelKey;
  /** The source this channel's replays are published under. Several channels
   *  may share one; badge styling is index-based over sourceChannels. */
  source: SourceId;
  /** Display name (mirrors app/app.config.ts sourceChannels[].name). */
  name: string;
  /** YouTube channel id. Absent on an `index` source, which has no channel. */
  channelId?: string;
  /** The channel's uploads playlist (UU + channelId.slice(2), pinned).
   *  Absent on an `index` source. */
  uploadsPlaylist?: string;
  /** This intake is a third-party INDEX, not a YouTube channel. Its dump is
   *  built by scripts/fetch-theater.ts, its records are not built by a title
   *  parse, and data:fetch skips it. Mutually exclusive with channelId. */
  index?: ChannelIndex;
  /**
   * LOCAL-FIRST: deliberately not part of the daily cron.
   *
   * raw/ is gitignored and the cron fetches remotely into a fresh checkout, so
   * a source only ever fetched by hand has no dump there. Without this flag
   * parse would exit (missing dump) or, worse, drop every one of its records.
   * So when the dump is ABSENT its committed records are CARRIED; when it is
   * PRESENT they are rebuilt.
   *
   * The carry needs a count pin for the same reason a frozen channel would —
   * data/videos.json is both source and target — and it lives in
   * data/source-pins.json rather than a constant here, because a local-first
   * source GROWS.
   */
  localFirst?: boolean;
  /** This channel's titles never name a character, so match-shaped uploads are
   *  queued as 'character-completion' rather than counted as parse misses and
   *  the characters are read from the footage (scripts/hud-read.ts). */
  charactersFromFootage?: boolean;
  /** This channel publishes MORE THAN TEKKEN, so an upload must carry a Tekken 8
   *  marker to be considered at all.
   *
   *  The four original channels need no such test — they are Tekken-only by
   *  construction, which is why parse.ts had no game predicate before Evo. Evo
   *  runs every game at the event, so the marker exists for this channel and
   *  only this channel; leaving it unset preserves the old behaviour exactly. */
  gameSignal?: 'titleOrDescription';
}

/** One upload as fetched from the YouTube Data API (raw/<id>.json). */
export interface RawVideoRecord {
  id: string;
  /** Intake channel, NOT the source — parse maps it via CHANNELS. */
  channel: ChannelKey;
  title: string;
  description: string;
  publishedAt: string; // ISO
  /** ISO8601 duration decoded to seconds; 0 = live/upcoming/unknown. */
  durationSec: number;
  viewCount?: number;
  /** 'none' for normal VODs; 'live'/'upcoming' are excluded by parse. */
  liveBroadcastContent: string;
  tags?: string[];
}

/**
 * One record in raw/replayTheater.json — an index entry already joined to its
 * VOD's YouTube metadata. Extends RawVideoRecord so the dump reads like any
 * other, but the fields below are what the record is actually BUILT from:
 * nothing here is recovered by parsing the title.
 */
export interface TheaterRawRecord extends RawVideoRecord {
  /** `${videoId}@${startSeconds}` — the record id, not a YouTube id. */
  id: string;
  /** The catalogue's own entry id. Provenance, and the fetch resume key. */
  theaterId: number;
  /** The YouTube id this segment lives inside. */
  videoId: string;
  /** Offset into videoId, in seconds. */
  startSeconds: number;
  /** The catalogue's event tag. Non-empty by construction — an untagged entry
   *  is online ranked play and never reaches the dump. */
  tag: string;
  /** The VOD's own uploader, for the report. The source VODs belong to eleven
   *  different organisers, so this is per record, not per intake. */
  uploader: string;
  /** [side0, side1] handles, exactly as the catalogue spells them — sponsor
   *  prefixes intact, for the parser to strip. */
  players: [string, string];
  /** [side0, side1] character names, exactly as the catalogue spells them.
   *  Tekken is 1v1 so a side is normally one long, but the catalogue carries
   *  four columns and a set can counter-pick — MatchSide.characters is already
   *  an ordered union, so a longer side needs no schema change. */
  characters: [string[], string[]];
}

/** One parsed side: one pilot, and EVERY character that pilot played.
 *
 *  Tekken is 1v1, so a single game has exactly one character per side — but a
 *  record is a VOD, and a tournament VOD is a SET. Tekken sets counter-pick
 *  between games, so a side holds the ordered union of every character it
 *  played, in first-appearance order. A single-game upload is simply the
 *  length-1 case, which is what every title-parsed record from the four
 *  original channels still is.
 *
 *  Which game a switch happened in is deliberately not modelled: the footage
 *  supports "this player played these characters, in this order" and not more. */
export interface MatchSide {
  /** Player id (slug of handle). */
  player: string;
  /** Display handle, nicest casing seen (descriptions beat ALL-CAPS titles). */
  handle: string;
  /** Roster character ids (data/characters.json), first-appearance order.
   *  Always ≥1 — emit.ts hard-fails an empty side. */
  characters: string[];
  /** Ladder rank, normalized to GameConfig.ranks entries (GoD sub-tiers →
   *  'God of Destruction'). Absent when the source didn't state one. */
  rank?: string;
}

/** The committed parse substrate (data/videos.json): only structurally parsed
 *  matches enter it; misses are reported, not stored. */
export interface MatchVideo {
  id: string;
  /** Resolved source (Replay.source), not the intake channel. */
  channel: SourceId;
  /** The YouTube channel this came from, retained through parse.
   *
   *  `channel` above is the PUBLIC source and several channels may share one —
   *  'tournament' already aggregates every event organizer. That makes the
   *  source useless for anything that has to tell two channels apart, which is
   *  exactly what duplicate precedence needs to do: it must be able to say
   *  "the event's own upload beats the re-uploader" between two records whose
   *  `channel` is the identical string. Keeping the intake key is what makes
   *  that expressible, and it keeps the coverage report per-channel auditable. */
  intake: ChannelKey;
  title: string;
  publishedAt: string;
  durationSec: number;
  viewCount?: number;
  /** Tekken 8 season, resolved from title/description tokens or the date
   *  boundaries (data/seasonBoundaries.json). Replay.patch = patchVersion,
   *  falling back to `S${season}` when the fine patch is unknown. */
  season: number;
  /** boundary-derived patch token ("2.03", from data/patchBoundaries.json);
   *  null = the season (label-grace or override) contradicts the date —
   *  "season known, patch unknown", emitted as the bare era token */
  patchVersion: string | null;
  /** The YouTube id, when `id` is not it. A record is not required to be a
   *  whole video: an index intake publishes many records per VOD, so their ids
   *  are `${videoId}@${startSeconds}` and the YouTube id lives here. Every
   *  YouTube-shaped URL the engine builds resolves `videoId ?? id`. */
  videoId?: string;
  /** Where this record's footage starts inside `videoId`, in seconds. Absent
   *  (or 0) means the whole video. */
  startSeconds?: number;
  sides: [MatchSide, MatchSide];
}

/** data/source-pins.json — the carry pin for every `localFirst` intake, keyed
 *  by ChannelKey. Written by a rebuild, hard-asserted by every carrying run. */
export type SourcePins = Partial<Record<ChannelKey, number>>;

/** data/players.json entry (mirrors the engine's Player). */
export interface PlayerRecord {
  id: string;
  handle: string;
  featured?: boolean;
  extra?: { aliases?: string[] };
}

/** data/characters.json entry (mirrors the engine's Character). `aliases` is
 *  the well-known search/parse key; the other extra keys ("full name",
 *  "japanese") render on the character page's generic key/value strip. */
export interface CharacterRecord {
  id: string;
  name: string;
  imgPortrait: string;
  imgSplash?: string;
  accent: string;
  extra?: { aliases: string[]; [k: string]: unknown };
}

/** Per-video manual corrections (data/overrides.json): exclude stray uploads
 *  or patch a bad parse. Applied by parse.ts AND the standalone emit.
 *
 *  For a charactersFromFootage channel a `sides` override is not a correction
 *  at all — it is the ONLY way the record exists, because no text on the upload
 *  names a character. `resolvedBy` records which path produced it so the two
 *  stay distinguishable after the fact. */
export type VideoOverride = Partial<Pick<MatchVideo, 'season' | 'patchVersion' | 'sides'>> & {
  exclude?: boolean;
  /** 'extractor' = read from the footage by scripts/complete-characters.ts;
   *  'human' = a verdict entered through /dev/source-review. Absent on the
   *  hand-authored corrections that predate the queue. */
  resolvedBy?: 'extractor' | 'human';
  /** Extractor confidence at resolution time (see scripts/hud-read.ts's fold).
   *  Recorded for auditing; nothing reads it back to re-decide. */
  confidence?: number;
  /** Signed vote margin from reading the HUD's player plates to decide which
   *  side each handle sat on (scripts/hud-read.ts `resolveSide`). Recorded
   *  because attribution is the half of a footage-read record that no
   *  confidence number covers: the characters can be perfect while the players
   *  are swapped, so a later dispute needs to see how firmly the side was
   *  decided. Positive = the title's first-named player was on the left. */
  sideVotes?: number;
};

/** One pending item in data/review-queue.json — parseable footage the pipeline
 *  refuses to auto-publish. REGENERATED by every parse run (derived state:
 *  resolutions live solely in overrides.json, so the queue self-clears as
 *  verdicts land and survives daily runs untouched). Pending items never reach
 *  videos.json or replays.json; report.md counts them.
 *
 *  Kinds: 'character-completion' — match-shaped footage whose characters no
 *  text states (verdict: a complete `sides` override); 'source-classification'
 *  — an upload carrying conflicting channel/event signals (verdict: a `channel`
 *  or `exclude` override). Tekken has no multi-source channel today, so the
 *  second kind is empty here; the schema and the /dev surface already speak it
 *  so one can be added without a schema change. */
export interface ReviewQueueItem {
  id: string;
  kind: 'character-completion' | 'source-classification';
  /** Intake channel the video came from (raw/<key>.json). */
  channel: ChannelKey;
  title: string;
  publishedAt: string;
  durationSec: number;
  /** Player handles the title stated, already canonicalised by parse.ts so a
   *  verdict cannot mint a second page for an existing player. */
  handles?: [string, string];
  /** Why this is pending, for the review surface. */
  reason: string;
}

/** Season boundaries persisted by parse.ts (data/seasonBoundaries.json):
 *  static defaults auto-tuned against explicit SN title tokens, so untagged
 *  uploads date-resolve deterministically. */
export interface SeasonBoundary {
  season: number;
  start: string; // ISO date, inclusive
  end: string | null; // exclusive; null = open (current season)
}

/** One released patch (data/patchBoundaries.json — see its "//" header for
 *  the wavu-sourced authoring + fold rules). Windows are computed by
 *  scripts/patches.ts, never authored. */
export interface PatchBoundary {
  /** the folded patch token as the community names it, e.g. "2.03" */
  version: string;
  /** release day (ISO; a season opener starts at the season boundary) */
  start: string;
  /** X.YY.ZZ hotfix releases folded into this patch (documentation only) */
  includes?: string[];
  /** short community-facing hint (DLC character, headline feature) */
  note?: string;
  /** unconfirmed-row marker — exempts the row from the opening-patch validation */
  todo?: string;
}
