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
];

// Evaluated and deliberately NOT tracked (recon 2026-07):
//
// "Evo Events" (UCWI626ZNdqM5tOlctPUTW2g) — 67 single-match Tekken 8 uploads
// across Evo/Evo Japan/Evo France 2024-2026, and every one of them is
// unusable here: the titles name the players but never the characters ("Evo
// 2026: Arslan Ash vs Rangchu | TEKKEN 8 | Grand Final"), the descriptions
// only restate the title, and the videos carry no tags at all. A record needs
// a character per side (charactersPerSide: 1; emit.ts hard-fails without
// one), so these can only be added by watching each match and hand-writing
// data/overrides.json. Revisit if Evo ever starts tagging characters.
