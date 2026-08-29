// The YouTube Data API v3 client, shared by the two stage-1 fetchers.
//
// Extracted from scripts/fetch.ts when the index intake arrived: it needs the
// same retry ladder and the same key handling to resolve the VODs its segments
// point into, and a second copy of a backoff loop is a second place for it to
// drift. Nothing here knows about channels or the catalogue.
//
// The key is LOCAL/CI-ONLY — never on Vercel, which builds from committed JSON.

const API_BASE = 'https://www.googleapis.com/youtube/v3';

let cachedKey: string | undefined;

/** Read YT_API_KEY, or fail loudly naming the command that needed it.
 *  Called explicitly by each entry point rather than at import, so importing
 *  anything from this module cannot kill an unrelated script. */
export function requireApiKey(command: string): string {
  if (cachedKey) return cachedKey;
  const raw = process.env.YT_API_KEY;
  if (!raw) {
    console.error(
      [
        `✖ Missing YT_API_KEY (needed by ${command}).`,
        '  Create a .env file in the project root containing:',
        '    YT_API_KEY=your_key_here',
        `  (see .env.example). ${command} loads it via \`tsx --env-file-if-exists=.env\`.`,
      ].join('\n'),
    );
    process.exit(1);
  }
  cachedKey = raw;
  return raw;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with retry on 5xx / 429, fail loudly on other 4xx. */
export async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>,
  retries = 5,
): Promise<T> {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', requireApiKey(endpoint));

  for (let attempt = 1; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `  ⚠ network error on ${endpoint} (attempt ${attempt}/${retries}); retrying in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }

    if (res.ok) return (await res.json()) as T;

    const body = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `  ⚠ HTTP ${res.status} on ${endpoint} ${JSON.stringify(params)} (attempt ${attempt}/${retries}); retrying in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }
    // Non-retryable 4xx or out of retries → fail loudly with the API's error
    // body. (The key is never included: it is only ever set on the URL.)
    throw new Error(
      `YouTube API error: HTTP ${res.status} on ${endpoint} ${JSON.stringify(params)}\n${body}`,
    );
  }
  throw new Error('unreachable');
}

/** ISO8601 duration (PT#H#M#S) → seconds. 0 = live/upcoming/unknown. */
export function parseDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export interface VideoMeta {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec: number;
  viewCount?: number;
  liveBroadcastContent: string;
  /** The uploading channel's display name. An index source's VODs belong to
   *  many different organisers, so this is per video, not per intake. */
  uploader: string;
  tags?: string[];
}

interface VideosResponse {
  items: {
    id: string;
    snippet: {
      title: string;
      description: string;
      publishedAt: string;
      liveBroadcastContent: string;
      channelTitle?: string;
      tags?: string[];
    };
    contentDetails: { duration?: string };
    statistics?: { viewCount?: string };
  }[];
}

/** Hydrate arbitrary video ids, 50 per call. Returns a Map so the caller can
 *  diff for ids that did not come back — a video gone private or deleted is a
 *  fact about the corpus, not noise to swallow. */
export async function fetchVideoMeta(ids: string[]): Promise<Map<string, VideoMeta>> {
  const out = new Map<string, VideoMeta>();
  for (let i = 0; i < ids.length; i += 50) {
    const res: VideosResponse = await apiGet('videos', {
      part: 'snippet,contentDetails,statistics',
      id: ids.slice(i, i + 50).join(','),
      maxResults: '50',
    });
    for (const v of res.items) {
      out.set(v.id, {
        id: v.id,
        title: v.snippet.title,
        description: v.snippet.description,
        publishedAt: v.snippet.publishedAt,
        durationSec: parseDuration(v.contentDetails.duration),
        ...(v.statistics?.viewCount ? { viewCount: Number(v.statistics.viewCount) } : {}),
        liveBroadcastContent: v.snippet.liveBroadcastContent,
        uploader: v.snippet.channelTitle ?? '',
        ...(v.snippet.tags ? { tags: v.snippet.tags } : {}),
      });
    }
  }
  return out;
}
