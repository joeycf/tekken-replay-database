// Pipeline-track types (plain node/tsx code — never enters the Nuxt graph, so
// the engine contract is restated where emitted shapes must mirror it, exactly
// like the 2XKO pipeline does).

/** The Replay.source contract: doubles as GameConfig.sourceChannels[].id
 *  (badge/filter). One source may be fed by SEVERAL YouTube channels —
 *  'tournament' aggregates the event organizers' channels, whose uploads are
 *  the same kind of replay regardless of who published them. */
export type SourceId = 'highLevel' | 'telly' | 'ranked' | 'tournament';

/** Per-YouTube-channel intake key: names raw/<key>.json and the coverage
 *  report's rows, so channels sharing a source stay separately auditable. */
export type ChannelKey = 'highLevel' | 'telly' | 'ranked' | 'bneEsports';

export interface ChannelConfig {
  /** Raw-dump key / report row (unique per YouTube channel). */
  id: ChannelKey;
  /** The source this channel's replays are published under. Several channels
   *  may share one; badge styling is index-based over sourceChannels. */
  source: SourceId;
  /** Display name (mirrors app/app.config.ts sourceChannels[].name). */
  name: string;
  /** YouTube channel id. */
  channelId: string;
  /** The channel's uploads playlist (UU + channelId.slice(2), pinned). */
  uploadsPlaylist: string;
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

/** One parsed side: exactly one pilot + one character (Tekken is 1v1). */
export interface MatchSide {
  /** Player id (slug of handle). */
  player: string;
  /** Display handle, nicest casing seen (descriptions beat ALL-CAPS titles). */
  handle: string;
  /** Roster character id (data/characters.json). */
  character: string;
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
  title: string;
  publishedAt: string;
  durationSec: number;
  viewCount?: number;
  /** Tekken 8 season, resolved from title/description tokens or the date
   *  boundaries (data/seasonBoundaries.json). Replay.patch = `S${season}`. */
  season: number;
  sides: [MatchSide, MatchSide];
}

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
 *  or patch a bad parse. Applied by parse.ts AND the standalone emit. */
export type VideoOverride = Partial<Pick<MatchVideo, 'season' | 'sides'>> & {
  exclude?: boolean;
};

/** Season boundaries persisted by parse.ts (data/seasonBoundaries.json):
 *  static defaults auto-tuned against explicit SN title tokens, so untagged
 *  uploads date-resolve deterministically. */
export interface SeasonBoundary {
  season: number;
  start: string; // ISO date, inclusive
  end: string | null; // exclusive; null = open (current season)
}
