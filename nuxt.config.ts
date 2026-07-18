import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinURL } from 'ufo';

import charactersData from './data/characters.json';
import playersData from './data/players.json';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const engineDir = fileURLToPath(
  new URL(process.env.ENGINE_PATH || '../replay-engine', new URL('.', import.meta.url)),
);

// Prerender EVERYTHING entity-shaped: the full Tekken roster + every player
// profile (players parsed from titles must not 404 on static hosting), plus
// the core routes. The engine seeds '/', '/health', '/not-found' itself and
// emits sitemap/robots/manifest/404.html from the REAL prerendered list
// (modules/static-artifacts). Tekken deliberately keeps the default
// characterRouteSegment, so the roster lives at /characters/*.
const characters = charactersData as { id: string }[];
const players = playersData as { id: string }[];
const appRoutes = [
  '/stats',
  '/characters',
  '/players',
  ...characters.map((c) => `/characters/${c.id}`),
  ...players.map((p) => `/players/${p.id}`),
];

export default defineNuxtConfig({
  // The replay-engine layer: local checkout during co-development
  // (ENGINE_PATH in .env), the pinned tag everywhere else (Vercel leaves
  // ENGINE_PATH unset). Never track a branch — bump the pin deliberately.
  // `install: true` is REQUIRED for git layers: without it the cloned layer
  // gets no node_modules and its runtime deps (@tailwindcss/vite, ufo, …)
  // don't resolve (STACK §5.5, verified in the Phase-3 remote-layer check).
  extends: [process.env.ENGINE_PATH || ['github:joeycf/replay-engine#v0.5.3', { install: true }]],

  compatibilityDate: '2025-07-01',

  // Tekken lives under /tekken/ behind the shell (replaydatabase.com — the
  // Phase-5 subpath cutover). The env expression is REQUIRED, not decorative:
  // a literal baseURL here shadows the engine's own env read (app config wins
  // the layer merge), and NUXT_APP_BASE_URL alone then flips only the runtime
  // router — prerender seeds stay root-based and every route 404s the build
  // (STACK §5.3 desync, reproduced empirically in Phase 5). The committed
  // default IS the production truth; the env var overrides for special builds
  // (e.g. NUXT_APP_BASE_URL=/ for a root-based local preview).
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL || '/tekken/',
  },

  // The Tekken theme (palette + self-hosted fonts) — loads after the engine's
  // CSS, so its @theme values shadow the umbrella defaults (README contract).
  css: ['~/assets/theme.css'],

  modules: [
    // Seed the entity routes under the final resolved base (same mechanism as
    // the engine's own seeds — static prerender arrays are not base-prefixed).
    function appPrerenderSeeds(_options, nuxt) {
      nuxt.hook('nitro:init', (nitro) => {
        for (const route of appRoutes) {
          nitro.options.prerender.routes.push(joinURL(nuxt.options.app.baseURL, route));
        }
      });
    },
  ],

  hooks: {
    // The whale file: data/replays.json (committed, pipeline-emitted) →
    // public/data/ (gitignored) for the engine's client fetch. Lives in the
    // BUILD because Vercel never runs the pipeline — it builds from committed
    // JSON, exactly like the 2XKO app's flow.
    'build:before'() {
      const dataDir = join(rootDir, 'public/data');
      mkdirSync(dataDir, { recursive: true });
      cpSync(join(rootDir, 'data/replays.json'), join(dataDir, 'replays.json'));
      console.log('✓ copied data/replays.json → public/data/replays.json');
    },
  },

  typescript: {
    // Typecheck runs explicitly via `npm run typecheck` (vue-tsc + pipeline tsc).
    typeCheck: false,
    // app/app.config.ts lands in the generated NODE tsconfig, which doesn't
    // inherit the engine layer's @engine alias — mirror it for the type-only
    // GameConfig import (erased at build; typecheck is a local operation that
    // assumes the sibling engine checkout per the STACK dev loop).
    nodeTsConfig: {
      compilerOptions: {
        paths: {
          '@engine': [engineDir],
          '@engine/*': [`${engineDir}/*`],
        },
      },
    },
  },
});
