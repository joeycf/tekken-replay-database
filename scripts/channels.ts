// The tracked Tekken 8 replay channels — the bespoke half of the pipeline's
// intake (PLAN §5: "tekken pipeline in /scripts"). Selection criteria from the
// build recon (2026-07): dense daily uploads of full ranked/player-match VODs,
// ≥98% structurally parseable "PLAYER (Character) vs PLAYER (Character)"
// titles, and per-side LADDER ranks in the descriptions ("Keisuke (God of
// Destruction 6 Kazuya) Versus …") — the rank filter's data source.
//
// The id is the public Replay.source contract (mirrored in app.config.ts
// sourceChannels; badge styling is index-based: 0 = filled primary,
// 1 = secondary outline, 2+ = warning outline).

import type { ChannelConfig } from '../types/index';

export const CHANNELS: ChannelConfig[] = [
  {
    // "Tekken 8 Replays" — the flagship high-level channel (100% parseable in
    // recon; ladder ranks in descriptions).
    id: 'highLevel',
    name: 'High Level',
    channelId: 'UC90YV4BSSHBG_a77vO6DOvw',
    uploadsPlaylist: 'UU90YV4BSSHBG_a77vO6DOvw',
  },
  {
    // "Tekken 8 Replays Telly" — the highest-volume archive (back-catalogue
    // spans seasons; richest "God of Destruction N" description ranks). Its
    // #shorts combo clips are structurally excluded by parse.
    id: 'telly',
    name: 'Telly',
    channelId: 'UCab17MxxnFtAhGsJVTkSkCg',
    uploadsPlaylist: 'UUab17MxxnFtAhGsJVTkSkCg',
  },
  {
    // "Tekken 8 High Level Replays" — ranked-ladder VODs ("T8 RANKED
    // GAMEPLAY"); descriptions carry leaderboard positions rather than ladder
    // ranks, so most of its sides ship rank-less (rank is optional per side).
    id: 'ranked',
    name: 'Ranked',
    channelId: 'UColiUuHLb7ft6ed6pJNFBUw',
    uploadsPlaylist: 'UUoliUuHLb7ft6ed6pJNFBUw',
  },
];
