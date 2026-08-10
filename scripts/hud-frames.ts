// Download tiny sections of a YouTube VOD and cut one PNG from each.
//
// Ported from sf6-replay-database/scripts/hud-frames.ts, which is itself a port
// of 2xko-replay-database/scripts/fuses.ts `ensureFrames`. Everything those two
// learned the hard way travels:
//   · --js-runtimes node — YouTube's n-challenge needs yt-dlp's EJS solver and
//     only Deno is enabled by default; this host solves via its own Node.
//   · SSL_CERT_FILE — the static ffmpeg build that serves --download-sections
//     has no CA bundle of its own and exits 251 without it.
//   · sleep after EVERY attempt, failures included. 2XKO's comment: a backlog
//     that retried instantly "fed the throttle spiral that produced the
//     'unavailable' pile in the first place".
//   · bot-check stderr → exit 2, so a dead session aborts loudly instead of
//     grinding through the corpus turning every video into a silent failure.
//
// Like SF6 and unlike 2XKO (which pulls one contiguous 0-12s clip), this samples
// SEPARATE one-second windows spread across the match: what identifies a
// character on screen is not guaranteed to sit in the first 12 seconds.
//
// THE COOKIE PREFLIGHT: 2XKO catches a bad credential before the first request
// (refresh-all.sh) and this does the same, lazily — so re-folding from cached
// frames still needs no credentials at all. SF6 used to be the odd one out,
// degrading silently to a cookieless download and only discovering it one
// bot-check later; it was back-ported this preflight in the 2026-08 housekeeping
// batch, so all three pipelines now check the same things in the same order.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = join(ROOT, 'cache', 'evo');

// The cookie file is a LIVE GOOGLE SESSION and lives in secrets/, never in the
// cache: cache/ is regenerable scratch by contract, and a credential in a
// directory that is safe to delete is one `rm -rf` from being lost. secrets/ is
// covered by .gitignore AND .vercelignore — the latter independently, because
// that file REPLACES gitignore-based exclusion for `vercel deploy` uploads.
const COOKIES = process.env.EVO_COOKIES ?? join(ROOT, 'secrets', 'yt-cookies.txt');

/** Warn (never fail) once a session export is older than this. */
const COOKIE_MAX_AGE_DAYS = 14;

// static ffmpeg TLS (see header)
if (!process.env.SSL_CERT_FILE) process.env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt';

const SLEEP_MIN = Number(process.env.EVO_SLEEP_MIN ?? 1);
const SLEEP_MAX = Number(process.env.EVO_SLEEP_MAX ?? 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const die = (msg: string): never => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(2);
};

let preflighted = false;

/** Validate the cookie file before the first download of a run. Deliberately
 *  LAZY: a re-fold from cached frames performs no requests and must not demand
 *  a credential it will never use. Ported from 2XKO's refresh-all.sh preflight,
 *  which checks the same things in the same order. */
export function preflightCookies(): void {
  if (preflighted) return;
  preflighted = true;

  if (!existsSync(COOKIES)) {
    die(
      `No YouTube session cookies at ${COOKIES}\n` +
        "  Downloads without them hit YouTube's bot-check on the first request.\n" +
        '  Export youtube.com cookies in Netscape format to that path (chmod 600),\n' +
        '  or point EVO_COOKIES at an existing export.',
    );
  }
  const st = statSync(COOKIES);
  if (!st.isFile()) die(`Cookie path is not a regular file: ${COOKIES}`);
  if (st.size === 0) die(`Cookie file is empty: ${COOKIES}`);

  // A credential inside the worktree that git can see is one `git add -A` from
  // being published. Refuse rather than warn.
  if (resolve(COOKIES).startsWith(resolve(ROOT))) {
    const ignored = spawnSync('git', ['check-ignore', '-q', COOKIES], { cwd: ROOT });
    if (ignored.status !== 0) {
      die(
        `${COOKIES} is inside the repo and is NOT gitignored.\n` +
          '  It is a live Google session. Add it to .gitignore (and .vercelignore)\n' +
          '  or move it outside the worktree and set EVO_COOKIES.',
      );
    }
  }

  if ((st.mode & 0o077) !== 0) {
    die(
      `Cookie file is group/world-readable (mode ${(st.mode & 0o777).toString(8)}): ${COOKIES}\n` +
        `  chmod 600 ${COOKIES}`,
    );
  }

  // Presence by NAME only — never read or log the values.
  const names = readFileSync(COOKIES, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t')[5])
    .filter(Boolean);
  const missing = ['SAPISID', 'LOGIN_INFO'].filter((n) => !names.includes(n));
  if (missing.length) {
    die(
      `Cookie export is missing ${missing.join(' and ')}: ${COOKIES}\n` +
        '  That is a logged-OUT export. Re-export while signed in to youtube.com.',
    );
  }

  const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
  if (ageDays > COOKIE_MAX_AGE_DAYS) {
    console.warn(
      `⚠ Cookie export is ${Math.floor(ageDays)} days old (${COOKIES}).\n` +
        '  Sessions expire; re-export if downloads start failing the bot-check.',
    );
  }
}

/** Seconds → the zero-padded label used in frame filenames and logs. */
export const stamp = (sec: number): string => String(Math.round(sec)).padStart(6, '0');

/** Download one ~1s window and cut a single PNG. Returns the PNG path, or null
 *  when the download or the cut failed (caller records and moves on). */
export async function grabFrame(id: string, sec: number): Promise<string | null> {
  const dir = join(CACHE, 'frames', id);
  const png = join(dir, `${stamp(sec)}.png`);
  if (existsSync(png)) return png;

  mkdirSync(dir, { recursive: true });
  const clipDir = join(CACHE, 'clips', id);
  mkdirSync(clipDir, { recursive: true });
  const clipStem = join(clipDir, stamp(sec));

  let clip = readdirSync(clipDir)
    .filter((f) => f.startsWith(`${stamp(sec)}.`))
    .map((f) => join(clipDir, f))[0];

  if (!clip) {
    preflightCookies();
    const r = spawnSync(
      'yt-dlp',
      [
        '--cookies',
        COOKIES,
        '--js-runtimes',
        'node',
        '--quiet',
        '--no-warnings',
        '--download-sections',
        `*${Math.max(0, Math.floor(sec))}-${Math.max(1, Math.floor(sec) + 1)}`,
        '-f',
        'bv*[height<=720]/bv*',
        '-o',
        `${clipStem}.%(ext)s`,
        `https://www.youtube.com/watch?v=${id}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: process.env, timeout: 180_000 },
    );
    // pace EVERY attempt, failures included
    await sleep((SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN)) * 1000);

    if (r.status !== 0) {
      const err = String(r.stderr ?? '').slice(0, 400);
      if (/confirm you.re not a bot|sign in to confirm/i.test(err)) {
        die(
          'YouTube bot-check hit — the session cookies passed preflight but are stale.\n' +
            `  Re-export youtube.com cookies (Netscape format) over ${COOKIES},\n` +
            '  or point EVO_COOKIES at a fresh export, then re-run.',
        );
      }
      return null;
    }
    clip = readdirSync(clipDir)
      .filter((f) => f.startsWith(`${stamp(sec)}.`))
      .map((f) => join(clipDir, f))[0];
    if (!clip) return null;
  }

  try {
    execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', clip, '-frames:v', '1', '-y', png],
      { env: process.env, timeout: 120_000 },
    );
  } catch {
    return null;
  }
  return existsSync(png) ? png : null;
}

/** Grab a whole set of timestamps for one video, sequentially. */
export async function grabFrames(id: string, secs: number[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of secs) {
    const p = await grabFrame(id, s);
    if (p) out.push(p);
  }
  return out;
}

/** Drop the (large) downloaded clips once frames are cut; frames are ~1% the size. */
export function pruneClips(id: string): void {
  const d = join(CACHE, 'clips', id);
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}
