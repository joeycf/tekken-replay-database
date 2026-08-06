import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

/** The repo's h3 version skew is not limited to bodies (see the sibling POST):
 *  nitro hands these routes a v1-shaped event (`event.node.req/res`) while the
 *  hoisted h3 is a v2 RC whose auto-imported helpers assume v2 shapes.
 *  `getQuery` does `new URL(req.url)` on what is only a PATH and throws
 *  "Invalid URL"; `setHeader` writes to `event.res.headers`, which does not
 *  exist. Both are reimplemented here against the node objects, which work
 *  under either shape — the `event.req` branches cover a future move to real v2
 *  events.
 *
 *  Rule of thumb for this repo: in a server route, reach for `event.node.*`,
 *  not for h3's auto-imports. */
function readQuery(event: unknown): Record<string, string> {
  const e = event as { node?: { req?: { url?: string } }; req?: { url?: string } };
  const raw = e.node?.req?.url ?? e.req?.url ?? '';
  const q = raw.indexOf('?');
  if (q === -1) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw.slice(q + 1))) out[k] = v;
  return out;
}

function setHead(event: unknown, key: string, value: string): void {
  const e = event as {
    node?: { res?: { setHeader?: (k: string, v: string) => void } };
    res?: { headers?: { set?: (k: string, v: string) => void } };
  };
  if (e.node?.res?.setHeader) e.node.res.setHeader(key, value);
  else e.res?.headers?.set?.(key, value);
}

// Dev-only: streams one cached HUD frame (cache/evo/frames/<id>/<sec>.png) so
// /dev/source-review can show the footage for a character-completion item.
//
// A character-completion verdict asks a human "which characters are in this
// video", and the queue item alone cannot answer that — the whole reason the
// kind exists is that no text states it. Without frames the reviewer has to
// open YouTube and scrub each VOD by hand; with them the answer is on screen.
//
// `?band=1` returns the HUD strip. A column of these lets a reviewer read every
// sampled moment of a VOD at a glance — including a character CHANGING mid-set,
// which any single frame hides.
//
// THE BAND STARTS AT THE TOP OF THE FRAME, and that is the point. Tekken 8
// splits the two facts a reviewer needs across the HUD: the PLAYER handle is in
// the top strip ("VARREL RANGCHU [L]", "TM | RB ARSLAN ASH") and the CHARACTER
// name sits below the health bar (scripts/hud-read.ts REGIONS). A band tight
// around the character alone — which is all the extractor needs — makes the
// reviewer confirm *which character* while giving them no way to confirm *whose
// character it is*, so verifying the handle meant opening the VOD.
//
// Cropping from y=0 through the character row costs ~70px of height and shows
// both, vertically aligned, so the player↔character pairing is readable in one
// glance. The extractor is unaffected: it crops from the frame, never from this
// endpoint.
//
// The strict-shape query guards double as path-traversal guards: `id` must be
// exactly a YouTube id and `n` exactly six digits, so neither can contain a
// separator or a dot segment.
const BAND_TOP = 0;
const BAND_HEIGHT = 0.15;

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const { id, n, band } = readQuery(event);
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{11}$/.test(id) ||
    typeof n !== 'string' ||
    !/^\d{6}$/.test(n)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'expected ?id=<videoId>&n=<NNNNNN>' });
  }
  const path = join(process.cwd(), 'cache/evo/frames', id, `${n}.png`);
  if (!existsSync(path)) throw createError({ statusCode: 404 });

  setHead(event, 'content-type', 'image/png');
  setHead(event, 'cache-control', 'no-store');
  if (band !== '1') return readFileSync(path);

  const img = sharp(path);
  const { width = 1280, height = 720 } = await img.metadata();
  return img
    .extract({
      left: 0,
      top: Math.round(height * BAND_TOP),
      width,
      height: Math.round(height * BAND_HEIGHT),
    })
    .png()
    .toBuffer();
});
