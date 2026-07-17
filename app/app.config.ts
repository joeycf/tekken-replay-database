import ranks from '../data/ranks.json';
import type { GameConfig } from '@engine/types';

/**
 * The Tekken 8 GameConfig — merged OVER the engine's neutral default
 * (PLAN §4a). Everything game-shaped the engine renders comes from here via
 * useGame(); the visual skin lives separately in app/assets/theme.css.
 *
 * The genericity knobs, deliberately:
 * - charactersPerSide 1 → single portrait per side, duo/synergy panels hide.
 * - filters.coOccurrence false → the "same side" filter never renders.
 * - filters.rank true + the 30-rank ladder (data/ranks.json, the same file
 *   the pipeline validates against) → the rank facet renders in ladder order.
 * - terms / characterRouteSegment / Side.players: UNSET. Tekken genuinely
 *   says "characters", ships at /characters/*, and has one player per side —
 *   the engine defaults are correct, so we exercise them (STACK §7).
 *
 * Accents are transcribed from design/handoff/tokens.css (--char-*), the
 * design system's source of truth — scripts/characters.ts reads the same
 * file when enriching data/characters.json, so config and data can't drift.
 */
export default defineAppConfig({
  game: {
    id: 'tekken8',
    slug: 'tekken',
    name: 'Tekken 8',
    // All-caps deliberately: the official brand is written TEKKEN, and this
    // value renders verbatim as the wordmark ("TEKKEN/REPLAY") and the
    // manifest short_name.
    shortName: 'TEKKEN',
    rightsHolder: 'Bandai Namco Entertainment',
    baseURL: '/tekken', // behind the shell at replaydatabase.com/tekken (Phase 5)
    siteUrl: 'https://replaydatabase.com',
    charactersPerSide: 1,
    filters: {
      coOccurrence: false, // tag-fighter filter — not a Tekken concept
      rank: true, // the ladder filter, options in ladder order
    },
    ranks,
    accents: {
      alisa: '#FF9ED2',
      anna: '#FF4E6E',
      armor_king: '#97A2B8',
      asuka: '#77B8F8',
      azucena: '#C98A4B',
      bob: '#F25C43',
      bryan: '#A9E24A',
      claudio: '#7FA9F5',
      clive: '#E88038',
      devil_jin: '#7A48E8',
      dragunov: '#9FB9D6',
      eddy: '#4FD65C',
      fahkumram: '#D6C04A',
      feng: '#2FB878',
      heihachi: '#E5B22F',
      hwoarang: '#FF6A30',
      jack8: '#7CB342',
      jin: '#4D8DFF',
      jun: '#8CDFC2',
      kazuya: '#E23B4E',
      king: '#FFC145',
      kuma: '#B5824E',
      kunimitsu: '#E062D8',
      lars: '#6BC6FF',
      law: '#FFE04A',
      lee: '#C7A6FF',
      leo: '#EFCB7A',
      leroy: '#C9A227',
      lidia: '#8CD3E8',
      lili: '#F2B8D8',
      miary_zo: '#45D4D8',
      nina: '#9B8AEC',
      panda: '#E8E4F0',
      paul: '#FF9C2E',
      raven: '#6E62B8',
      reina: '#C45CF0',
      shaheen: '#56C9A2',
      steve: '#2F82DC',
      victor: '#5A68E0',
      xiaoyu: '#FF7F98',
      yoshimitsu: '#3DF0B8',
      zafina: '#A65CC8',
    },
    // Order matters: SourceBadge styles by index (0 = filled primary,
    // 1 = secondary outline, 2+ = warning outline). Ids mirror
    // scripts/channels.ts — the pipeline's Replay.source contract.
    sourceChannels: [
      { id: 'highLevel', name: 'High Level' },
      { id: 'telly', name: 'Telly' },
      { id: 'ranked', name: 'Ranked' },
    ],
    fonts: {
      display: 'Rajdhani',
      ui: 'Archivo',
      mono: 'JetBrains Mono',
    },
    manifest: {
      themeColor: '#E13048',
      backgroundColor: '#0B0B0D',
    },
    ogImage: '/og-default.png',
  } satisfies GameConfig,
});
