import characters from '../../data/characters.json';
import players from '../../data/players.json';
import stats from '../../data/stats.json';
import type { Character, KnownStats, Player } from '@engine/types';

/**
 * Registry provisioning (PLAN §2.4 / engine README): the small registries are
 * statically imported (bundled once, synchronously available during SSR/
 * prerender AND on the client) and handed to the engine — this is what makes
 * character/player/stats pages prerender as real HTML with data-derived
 * titles (the SEO requirement), with no payload serialization and no
 * hydration drift. Only the whale file (replays.json) stays in public/data
 * for the client fetch. The same imports feed nuxt.config's prerender seeds.
 */
export default defineNuxtPlugin(() => {
  provideRegistries({
    characters: characters as Character[],
    players: players as Player[],
    stats: stats as unknown as KnownStats,
  });
});
