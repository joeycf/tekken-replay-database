// The tracked Tekken 8 replay channels — the bespoke half of the pipeline's
// intake (PLAN §5: "tekken pipeline in /scripts"). Selection criteria from the
// build recon (2026-07): dense daily uploads of full ranked/player-match VODs,
// ≥98% structurally parseable "PLAYER (Character) vs PLAYER (Character)"
// titles, and per-side LADDER ranks in the descriptions ("Keisuke (God of
// Destruction 6 Kazuya) Versus …") — the rank filter's data source.
//
// `id` is the intake key (raw/<id>.json + the report row); `source` is the
// public Replay.source contract (mirrored in app.config.ts sourceChannels;
// badge styling is index-based: 0 = filled primary, 1 = secondary outline,
// 2+ = warning outline). They differ once a source aggregates channels.

import type { ChannelConfig } from '../types/index';

export const CHANNELS: ChannelConfig[] = [
  {
    // "Tekken 8 Replays" — the flagship high-level channel (100% parseable in
    // recon; ladder ranks in descriptions).
    id: 'highLevel',
    source: 'highLevel',
    name: 'High Level',
    channelId: 'UC90YV4BSSHBG_a77vO6DOvw',
    uploadsPlaylist: 'UU90YV4BSSHBG_a77vO6DOvw',
  },
  {
    // "Tekken 8 Replays Telly" — the highest-volume archive (back-catalogue
    // spans seasons; richest "God of Destruction N" description ranks). Its
    // #shorts combo clips are structurally excluded by parse.
    id: 'telly',
    source: 'telly',
    name: 'Telly',
    channelId: 'UCab17MxxnFtAhGsJVTkSkCg',
    uploadsPlaylist: 'UUab17MxxnFtAhGsJVTkSkCg',
  },
  {
    // "Tekken 8 High Level Replays" — ranked-ladder VODs ("T8 RANKED
    // GAMEPLAY"); descriptions carry leaderboard positions rather than ladder
    // ranks, so most of its sides ship rank-less (rank is optional per side).
    id: 'ranked',
    source: 'ranked',
    name: 'Ranked',
    channelId: 'UColiUuHLb7ft6ed6pJNFBUw',
    uploadsPlaylist: 'UUoliUuHLb7ft6ed6pJNFBUw',
  },
  {
    // "Bandai Namco Esports" — the official TEKKEN World Tour channel, and the
    // 'tournament' source's first feed. Its per-match uploads already follow
    // the title contract exactly ("Farzeen (Victor) vs Mulgold (Claudio) -
    // TWT 2026: The MIXUP 2026 - Grand Finals"); the multi-hour stream VODs
    // ("… - Day 1", "… - Top 8") carry no "(Character) vs (Character)" and so
    // are structurally excluded by parse, which is exactly what we want.
    //
    // Two traps this channel sets, both handled elsewhere:
    // - Its tags say "TEKKEN 7" on nearly every upload (stale channel
    //   boilerplate — the descriptions link to the Tekken 8 site). Tags are
    //   NOT a game signal here; the pre-launch date gate is what keeps the
    //   channel's real Tekken 7 back-catalogue (2016 → TWT 2023) out.
    // - Sponsored pros are uploaded with org tags ("VIT JeonDDing", "RB
    //   Arslan Ash") — see ORG_PREFIXES in parse.ts.
    id: 'bneEsports',
    source: 'tournament',
    name: 'Tournament',
    channelId: 'UCKHx_yf3dI2ajWAjXRJ_9Rw',
    uploadsPlaylist: 'UUKHx_yf3dI2ajWAjXRJ_9Rw',
  },
  {
    // "Evo Events" — the event's own channel, 2,748 uploads across every game
    // it runs. 63 of them are single Tekken 8 matches (Evo, Evo Japan and Evo
    // France, 2024→2026), and none names a character: "Evo 2026: Arslan Ash vs
    // Rangchu | TEKKEN 8 | Grand Final" gives players, game and round and
    // nothing else. That is why the 2026-07 recon rejected the channel outright.
    //
    // It is tracked from 2026-08-07 because the characters can now be READ off
    // the broadcast HUD — Tekken 8 prints them below the health bars (the top
    // strip carries the player). Measured against 63 blind hand labels: 63/63
    // both-sides-exact, 126/126 per-side. See scripts/hud-read.ts.
    //
    // gameSignal is required and is the only channel that sets it: everything
    // else here is Tekken-only by construction, while this channel publishes
    // Street Fighter, Guilty Gear, 2XKO and the rest alongside. The marker is
    // the spelled "TEKKEN 8" and never a bare "T8" — on this channel T8
    // overwhelmingly means TOP 8 ("ST 3v3 EVO 2014: T8 Quarters" is Super
    // Turbo), and the bare token admits zero uploads the spelled form misses.
    //
    // charactersFromFootage routes its match-shaped uploads into the review
    // queue instead of counting them as parse misses.
    //
    // It publishes under the EXISTING 'tournament' source rather than minting
    // its own: that source already aggregates the event organizers, whose
    // uploads are the same kind of replay whoever posted them.
    id: 'evoEvents',
    source: 'tournament',
    name: 'Evo',
    channelId: 'UCWI626ZNdqM5tOlctPUTW2g',
    uploadsPlaylist: 'UUWI626ZNdqM5tOlctPUTW2g',
    gameSignal: 'titleOrDescription',
    charactersFromFootage: true,
  },
  {
    /**
     * THE FIRST INDEX SOURCE IN THIS REPO. replaytheater.app is a fan-curated
     * match catalogue: it hosts no video, it points AT video with a start
     * offset. An entry is a (videoId, startSeconds) pair plus players,
     * characters and an event tag, so a record here is a SEGMENT — 317 tagged
     * Tekken 8 matches cut from 62 longform VODs — which is why these records
     * are keyed `${videoId}@${start}` and not by video id.
     *
     * IT REUSES `tournament` RATHER THAN MINTING A SOURCE, and that is this
     * repo's model asserting itself over the sibling it is ported from. There,
     * one field is both the intake key and the public badge, so a catalogue had
     * to become a new badge. Here they are separate unions and `tournament`
     * already aggregates every event organiser — the precedent evoEvents set.
     * app/app.config.ts therefore needs NO edit: a second Tournament badge
     * would render identically to the first and tell a visitor nothing.
     *
     * WHAT IT ADDS. The tournament source is this repo's weakest: bneEsports
     * parses 8.1% of its uploads and evoEvents 2.3%, because both publish
     * longform event streams that a title parse cannot segment. This is that
     * segmentation, already done by hand, for 26 grassroots events across
     * eleven organiser channels none of which this repo tracks — measured at
     * zero overlap with anything already fetched, published or ruled on.
     *
     * WHAT IT IS NOT. A feed. The catalogue's tagged Tekken data stops at
     * 2025-03-16 and has had nothing in 2026, so this is a closed historical
     * import; `data:theater` is worth re-running occasionally, not on a
     * cadence.
     *
     * NO channelId, NO uploadsPlaylist, NO gameSignal: there is no channel and
     * no title to gate. The game is checked per ENTRY against `gameLabel`.
     */
    id: 'replayTheater',
    source: 'tournament',
    name: 'Tournament VODs',
    index: {
      endpoint: 'https://replaytheater.app/api/matches',
      slug: 'tkn8',
      gameLabel: 'Tekken 8',
      pageSize: 50,
      pacingMs: 1200,
    },
    localFirst: true,
  },
];

/**
 * Sponsor/team prefix on a catalogue handle: "OEG | Slate", "NP | Senshi".
 * STRIPPED, never split — "|" is not a duo delimiter here, and treating it as
 * one would mint a player called "OEG" with a page of its own.
 *
 * APPLIED REPEATEDLY, not once. The catalogue carries doubly-prefixed handles,
 * and a single .replace() leaves the inner one in place — which mints a player
 * whose name still contains a sponsor tag, a worse outcome than not stripping
 * at all. Loop until stable.
 */
export const THEATER_SPONSOR = /^[^|]{1,12}\s*\|\s*/;

export const stripTheaterSponsor = (handle: string): string => {
  let out = handle.trim();
  // Bounded: each pass removes at least one "|", and a handle carries few.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(THEATER_SPONSOR, '').trim();
    if (next === out || next === '') break;
    out = next;
  }
  return out;
};

/** Channels the daily fetch contacts, and the channels whose records are built
 *  by a TITLE PARSE — the same set. An INDEX source is skipped by both: it has
 *  no channel to fetch and no title to parse. It stays in CHANNELS, so the
 *  collapse guard and the coverage report still see it. */
export const FETCHED_CHANNELS = CHANNELS.filter((c) => !c.index);

// No other candidate channel is pending. The bar the 2026-07 recon used was:
// dense uploads of full match VODs, and titles that are either structurally
// parseable or resolvable from the footage.
