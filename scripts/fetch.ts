// Stage 1: fetch every upload from the tracked channels via the YouTube Data
// API v3, dump raw metadata to raw/<channel>.json, and print a reconnaissance
// report. The API key is LOCAL-ONLY (never on Vercel — the site builds from
// committed JSON).
//
// Run: npm run data:fetch   (tsx --env-file-if-exists=.env scripts/fetch.ts)

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS, FETCHED_CHANNELS } from './channels';
import { aheadOfDump, newestUpload } from './freshness';
import { apiGet, parseDuration, requireApiKey } from './youtube';
import type {
  ChannelConfig,
  ChannelKey,
  DepartedEvidence,
  MatchVideo,
  RawVideoRecord,
} from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW_DIR = join(ROOT, 'raw');
requireApiKey('data:fetch');

// ── typed slices of the API responses (only the fields we read) ──────────────
interface PlaylistItemsResponse {
  items: { contentDetails: { videoId: string } }[];
  nextPageToken?: string;
}
interface VideosResponse {
  items: {
    id: string;
    snippet: {
      title: string;
      description: string;
      publishedAt: string;
      liveBroadcastContent: string;
      tags?: string[];
    };
    contentDetails: { duration?: string };
    statistics?: { viewCount?: string };
  }[];
}

async function fetchChannel(ch: ChannelConfig): Promise<RawVideoRecord[]> {
  // An index source has no channel and no playlist; it is pulled by
  // `npm run data:theater` and skipped by FETCHED_CHANNELS. Asserted rather
  // than assumed, because reaching here with one would page YouTube for
  // `playlistId=undefined` and return an empty dump that looks exactly like a
  // dead channel.
  if (!ch.uploadsPlaylist) {
    throw new Error(
      `${ch.id} has no uploadsPlaylist — an index source must be skipped before fetchChannel.`,
    );
  }

  // 1) every videoId from the uploads playlist (50/page)
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page: PlaylistItemsResponse = await apiGet('playlistItems', {
      part: 'contentDetails',
      playlistId: ch.uploadsPlaylist,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items) ids.push(it.contentDetails.videoId);
    pageToken = page.nextPageToken;
  } while (pageToken);

  // 2) hydrate in chunks of 50 (title/description/duration/views)
  const records: RawVideoRecord[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res: VideosResponse = await apiGet('videos', {
      part: 'snippet,contentDetails,statistics',
      id: chunk.join(','),
      maxResults: '50',
    });
    for (const v of res.items) {
      records.push({
        id: v.id,
        channel: ch.id,
        title: v.snippet.title,
        description: v.snippet.description,
        publishedAt: v.snippet.publishedAt,
        durationSec: parseDuration(v.contentDetails.duration),
        ...(v.statistics?.viewCount ? { viewCount: Number(v.statistics.viewCount) } : {}),
        liveBroadcastContent: v.snippet.liveBroadcastContent,
        ...(v.snippet.tags ? { tags: v.snippet.tags } : {}),
      });
    }
    if ((i / 50) % 20 === 19) console.log(`  …${ch.id}: ${records.length}/${ids.length}`);
  }
  return records;
}

// ── departures: the one case the stale-raw guard cannot judge from data ──────
// A channel that deletes its NEWEST upload and posts nothing after it leaves a
// fresh dump looking exactly like a stale one (scripts/freshness.ts). So this
// asks YouTube about the committed records newer than the dump — aheadOfDump,
// the guard's own selection — and records the ones no longer public. On an
// ordinary morning there are none, so it makes no call. One videos.list call
// covers 50 ids.
interface StatusResponse {
  items: { id: string; status: { privacyStatus: string } }[];
}

async function confirmDepartures(
  key: ChannelKey,
  dump: RawVideoRecord[],
  committed: MatchVideo[],
): Promise<DepartedEvidence> {
  const ahead = aheadOfDump(key, dump, committed).map((v) => v.id);
  const ids: string[] = [];
  for (let i = 0; i < ahead.length; i += 50) {
    const batch = ahead.slice(i, i + 50);
    const res: StatusResponse = await apiGet('videos', {
      part: 'status',
      id: batch.join(','),
      maxResults: '50',
    });
    const live = new Set(
      res.items.filter((v) => v.status.privacyStatus === 'public').map((v) => v.id),
    );
    ids.push(...batch.filter((x) => !live.has(x)));
  }
  return {
    channel: key,
    newestInDump: newestUpload(dump),
    checkedAt: new Date().toISOString(),
    ids,
  };
}

/** The committed corpus, for the departure check only. Absent or unreadable is
 *  treated as empty: no check runs, no departure is recorded, and the guard
 *  stays strict. parse.ts refuses an unreadable videos.json itself. */
const committed: MatchVideo[] = await readFile(join(ROOT, 'data', 'videos.json'), 'utf8')
  .then((t) => JSON.parse(t) as MatchVideo[])
  .then((v) => (Array.isArray(v) ? v : []))
  .catch(() => []);

// ── main ─────────────────────────────────────────────────────────────────────
await mkdir(RAW_DIR, { recursive: true });
const skipped = CHANNELS.filter((c) => c.index);
console.log(
  `Fetching ${FETCHED_CHANNELS.length} channel(s)` +
    (skipped.length
      ? `; skipping ${skipped.length} index source(s) — pull with \`npm run data:theater\` (${skipped
          .map((c) => c.id)
          .join(', ')})`
      : '') +
    '…',
);
for (const ch of FETCHED_CHANNELS) {
  const t0 = Date.now();
  const records = await fetchChannel(ch);
  records.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  // Asked BEFORE anything is written, so a check that throws leaves the
  // previous dump and its departure file together, untouched. The old file
  // still goes before the new dump lands, so the two are never from different
  // fetches; parse.ts checks the binding as well.
  const departed = await confirmDepartures(ch.id, records, committed);
  const departedPath = join(RAW_DIR, `${ch.id}.departed.json`);
  await rm(departedPath, { force: true });
  await writeFile(join(RAW_DIR, `${ch.id}.json`), JSON.stringify(records, null, 1) + '\n', 'utf8');
  await writeFile(departedPath, JSON.stringify(departed, null, 1) + '\n', 'utf8');
  const dates = records.map((r) => r.publishedAt.slice(0, 10));
  console.log(
    `✔ ${ch.id} (${ch.name}): ${records.length} uploads, ${dates[dates.length - 1] ?? '—'} → ${dates[0] ?? '—'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
  if (departed.ids.length)
    console.log(
      `  ↘ ${departed.ids.length} committed upload(s) newer than this dump are gone from ` +
        `YouTube (deleted, private or unlisted): ${departed.ids.join(', ')}. parse prunes them.`,
    );
}
console.log('Done. Next: npm run data:parse');
