// Stage 1: fetch every upload from the tracked channels via the YouTube Data
// API v3, dump raw metadata to raw/<channel>.json, and print a reconnaissance
// report. The API key is LOCAL-ONLY (never on Vercel — the site builds from
// committed JSON).
//
// Run: npm run data:fetch   (tsx --env-file-if-exists=.env scripts/fetch.ts)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS, FETCHED_CHANNELS } from './channels';
import { apiGet, parseDuration, requireApiKey } from './youtube';
import type { ChannelConfig, RawVideoRecord } from '../types/index';

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
  await writeFile(join(RAW_DIR, `${ch.id}.json`), JSON.stringify(records, null, 1) + '\n', 'utf8');
  const dates = records.map((r) => r.publishedAt.slice(0, 10));
  console.log(
    `✔ ${ch.id} (${ch.name}): ${records.length} uploads, ${dates[dates.length - 1] ?? '—'} → ${dates[0] ?? '—'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
}
console.log('Done. Next: npm run data:parse');
