<template>
  <section class="mx-auto w-full max-w-[900px] px-4 py-8 md:px-[26px]">
    <ClientOnly>
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div>
          <p class="font-mono text-label uppercase text-text-muted">Curation — dev only</p>
          <h1 class="mt-1 font-display text-d2 font-bold text-text">Source review</h1>
        </div>
        <p class="ml-auto font-mono text-[12px] text-text-muted">
          verdicts → data/overrides.json · then run
          <span class="text-text">npm run data:parse</span>
        </p>
      </div>

      <p
        v-if="error"
        class="mt-6 font-mono text-body text-warning"
      >
        Failed to load the queue — is this `nuxt dev`, and does data/review-queue.json exist?
      </p>
      <p
        v-else-if="items.length === 0"
        class="mt-6 font-mono text-body text-success"
      >
        Queue is empty — nothing pending review.
      </p>

      <template v-else-if="item">
        <!-- progress -->
        <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12px]">
          <span class="text-text-secondary">
            <span class="text-text">{{ cursor + 1 }}</span> / {{ items.length }}
          </span>
          <span class="text-success">{{ resolvedCount }} resolved</span>
          <span class="text-text-muted">keys: ⏎ save · s swap handles · x exclude · ←/→</span>
        </div>

        <!-- jump strip: one cell per item, colour = state -->
        <div class="mt-3 flex flex-wrap gap-[3px]">
          <button
            v-for="(it, i) in items"
            :key="it.id"
            type="button"
            :title="`${i + 1}. ${it.id} — ${stateOf(it)}`"
            class="h-2.5 w-2.5 border transition-transform"
            :class="[
              stateOf(it) === 'resolved'
                ? 'border-success/40 bg-success/70'
                : 'border-white/15 bg-white/[0.06]',
              i === cursor ? 'scale-150 !border-primary' : '',
            ]"
            @click="cursor = i"
          />
        </div>

        <!-- the item under review -->
        <div class="mt-4 cut border border-white/10 bg-surface">
          <div
            class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.07] px-4 py-2 font-mono text-[11px] text-text-secondary"
          >
            <span class="uppercase text-warning">{{ item.kind }}</span>
            <span>{{ item.id }}</span>
            <span>{{ item.channel }}</span>
            <span>{{ item.publishedAt.slice(0, 10) }}</span>
            <span>{{ fmtDur(item.durationSec) }}</span>
            <a
              :href="`https://youtu.be/${item.id}`"
              target="_blank"
              rel="noopener"
              class="ml-auto underline decoration-white/20 hover:text-text"
              >youtube ↗</a
            >
          </div>
          <p class="px-4 pt-2 font-mono text-[12px] text-text">{{ item.title }}</p>

          <div class="flex flex-wrap gap-4 px-4 py-3">
            <img
              :src="`https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`"
              :alt="`${item.id} thumbnail`"
              class="w-[320px] max-w-full border border-white/10"
            />
            <p
              v-if="item.saved"
              class="min-w-[220px] flex-1 self-center font-mono text-[12px] text-success"
            >
              saved: {{ savedLabel(item) }}
            </p>
          </div>

          <div class="border-t border-white/[0.07] px-4 py-3">
            <!-- HUD bands, cropped from the top of the frame so each one shows
                 the PLAYER handle (top strip) above the CHARACTER name (below
                 the health bar). Both facts, vertically aligned, so the
                 player↔character pairing is confirmable without opening the
                 VOD — and a mid-set character change is visible down the
                 column, which no single frame shows. -->
            <div v-if="item.frames.length">
              <p class="font-mono text-label uppercase text-text-muted">
                HUD — {{ item.frames.length }} sampled moments
                <span class="ml-2 normal-case text-text-secondary"
                  >left = side 1 · right = side 2 · handle above, character below</span
                >
              </p>
              <!-- Boundary bleed: the one failure mode the bands cannot settle
                   on their own. -->
              <p class="mt-1 font-mono text-[11px] normal-case text-text-muted">
                A character showing up <span class="text-text">only</span> in the first or last
                strips, never beside a mid-set read, may be footage bleeding in from the adjacent
                set — check it belongs to this match before recording it.
              </p>
              <div class="mt-2 flex flex-col gap-1">
                <div
                  v-for="f in item.frames"
                  :key="f"
                  class="flex items-center gap-2"
                >
                  <span class="w-10 shrink-0 text-right font-mono text-[10px] text-text-muted">{{
                    fmtDur(Number(f))
                  }}</span>
                  <img
                    :src="api(`/api/dev/review-frame?id=${item.id}&n=${f}&band=1`)"
                    :alt="`${item.id} @${f}s HUD`"
                    loading="lazy"
                    class="min-w-0 flex-1 border border-white/10"
                  />
                </div>
              </div>
            </div>
            <p
              v-else
              class="font-mono text-[12px] text-warning"
            >
              No cached frames for this id — open the VOD on YouTube, or pull frames with
              <span class="text-text">tsx scripts/spike/extract-chars.ts --ids {{ item.id }}</span>
            </p>

            <!-- Handles get their own row so the swap sits BETWEEN them. It is
                 needed often: the handles pre-fill in the TITLE's order, and on
                 this channel the title names the left player second about a
                 third of the time, while the bands above are read left to
                 right. Without the swap that mismatch is entered silently. -->
            <div class="mt-4 flex items-end gap-2 font-mono text-[12px] text-text-secondary">
              <label class="min-w-0 flex-1">
                side 1 handle
                <input
                  v-model="handles[0]"
                  type="text"
                  class="mt-1 w-full border border-white/15 bg-transparent px-2 py-1 text-text"
                />
              </label>
              <button
                type="button"
                class="cursor-pointer border border-white/20 px-3 py-1.5 font-mono text-[12px] text-text-secondary hover:border-white/40"
                title="[s] swap the two handles — the characters stay where they are"
                aria-label="swap the two player handles"
                @click="swapHandles()"
              >
                ⇄
              </button>
              <label class="min-w-0 flex-1">
                side 2 handle
                <input
                  v-model="handles[1]"
                  type="text"
                  class="mt-1 w-full border border-white/15 bg-transparent px-2 py-1 text-text"
                />
              </label>
            </div>

            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              <div
                v-for="i in [0, 1]"
                :key="i"
                class="font-mono text-[12px] text-text-secondary"
              >
                <p class="text-text-muted">side {{ i + 1 }} — {{ handles[i] || '(no handle)' }}</p>

                <!-- Every character this side played, in the order they first
                     appear in the bands above. A single-game upload is the
                     length-1 case; a counter-pick adds a second. -->
                <ul
                  v-if="chars[i]!.length"
                  class="mt-2 flex flex-wrap gap-1"
                >
                  <li
                    v-for="(c, n) in chars[i]"
                    :key="c"
                    class="flex items-center gap-1 border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-primary"
                  >
                    <span class="text-text-muted">{{ n + 1 }}</span>
                    {{ nameOf(c) }}
                    <button
                      type="button"
                      class="cursor-pointer px-0.5 text-text-muted hover:text-warning"
                      :aria-label="`remove ${nameOf(c)} from side ${i + 1}`"
                      @click="chars[i]!.splice(n, 1)"
                    >
                      ×
                    </button>
                  </li>
                </ul>

                <select
                  :value="''"
                  class="mt-2 w-full border border-white/15 bg-surface px-2 py-1 text-text"
                  :aria-label="`add a character to side ${i + 1}`"
                  @change="addChar(i, $event)"
                >
                  <option value="">
                    {{ chars[i]!.length ? '+ add character' : '— character —' }}
                  </option>
                  <option
                    v-for="c in roster"
                    :key="c.id"
                    :value="c.id"
                    :disabled="chars[i]!.includes(c.id)"
                  >
                    {{ c.name }}
                  </option>
                </select>
              </div>
            </div>
            <div class="mt-3 flex gap-2">
              <button
                type="button"
                class="cursor-pointer border border-success/50 bg-success/15 px-3 py-1.5 font-mono text-[12px] text-success hover:bg-success/25"
                :disabled="posting || !sidesComplete"
                @click="completeSides()"
              >
                Save sides
              </button>
              <button
                type="button"
                class="cursor-pointer border border-white/20 px-3 py-1.5 font-mono text-[12px] text-text-secondary hover:border-white/40"
                :disabled="posting"
                @click="exclude()"
              >
                [x] Exclude
              </button>
            </div>
          </div>
        </div>
      </template>

      <template #fallback>
        <p class="mt-6 font-mono text-body text-text-muted">Loading…</p>
      </template>
    </ClientOnly>
  </section>
</template>

<script setup lang="ts">
// Dev-only curation page for data/review-queue.json (parse.ts generates it;
// pending items never reach the site). Verdicts POST to /api/dev/source-review
// which validates and writes ONLY data/overrides.json; the queue self-clears on
// the next `npm run data:parse`.
//
// Tekken has no multi-source channel today, so every item here is
// 'character-completion'. The 'source-classification' kind is still in the
// schema and the endpoint still validates it — adding a channel that publishes
// two kinds of footage should not need a schema change.
if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' });
}

interface QueueItem {
  id: string;
  kind: 'source-classification' | 'character-completion';
  channel: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  /** handles the title stated (Evo names both players, neither character) */
  handles?: [string, string];
  /** cached HUD frame stems under cache/evo/frames/<id>/ */
  frames: string[];
  saved: {
    verdict: 'exclude' | 'channel' | 'sides';
    channel?: string;
    /** the verdict already recorded in data/overrides.json, for revisits */
    sides?: { handle: string; characters: string[] }[];
  } | null;
}

// This app is served under a base path (/tekken/ in production, and in `nuxt
// dev` too because the committed baseURL IS the production truth). A bare
// '/api/...' would resolve against the ORIGIN and 404 — the API lives under the
// base like everything else.
const baseURL = useRuntimeConfig().app.baseURL;
const api = (p: string) => `${baseURL.replace(/\/$/, '')}${p}`;

const { data, error } = useAsyncData(
  'source-review',
  () =>
    $fetch<{ roster: { id: string; name: string }[]; items: QueueItem[] }>(
      api('/api/dev/source-review'),
    ),
  { server: false },
);

const items = computed(() => data.value?.items ?? []);
const roster = computed(() => data.value?.roster ?? []);
const cursor = ref(0);

// ?id=<videoId> opens straight at one item. Adjudicating a specific verdict
// otherwise means finding its cell among sixty-odd identical squares.
const route = useRoute();
watch(items, (list) => {
  const wanted = route.query.id;
  if (typeof wanted !== 'string' || !list.length) return;
  const i = list.findIndex((it) => it.id === wanted);
  if (i >= 0) cursor.value = i;
});
const posting = ref(false);
const item = computed(() => items.value[cursor.value] ?? null);
const resolvedCount = computed(() => items.value.filter((it) => it.saved).length);
const stateOf = (it: QueueItem) => (it.saved ? 'resolved' : 'pending');
const savedLabel = (it: QueueItem) =>
  it.saved?.verdict === 'channel' ? (it.saved.channel ?? 'channel') : (it.saved?.verdict ?? '');

// character-completion form state, reset per item. Handles pre-fill from the
// title when the source stated them — already canonicalised against
// players.json by scripts/spike/queue-evo.ts, which is what stops a verdict
// minting a second page for an existing player.
//
// CHARACTERS NEVER PRE-FILL FROM THE EXTRACTOR. This page is also the
// ground-truth labelling surface for the extraction spike, and a suggested
// answer would contaminate the measurement it feeds. The labels must stay blind.
//
// A REVISIT IS DIFFERENT, and the distinction is the whole point: an item that
// already carries a verdict loads THAT verdict back, because it is the
// reviewer's own previous answer rather than a machine suggestion. An
// unresolved item still opens blank, so a first pass is unaffected. Without
// this, correcting one side of one video means retyping both.
//
// `chars` is one ORDERED LIST per side: a tournament set is several games and a
// player may counter-pick between them, so a side records every character it
// played, in first-appearance order. Add-order IS that order — a reviewer reads
// the HUD bands top to bottom, which is chronological — so there is
// deliberately no reorder control.
const handles = ref<[string, string]>(['', '']);
const chars = ref<[string[], string[]]>([[], []]);
watch(
  item,
  () => {
    const prior = item.value?.saved?.verdict === 'sides' ? item.value.saved.sides : undefined;
    if (prior?.length === 2) {
      handles.value = [prior[0]!.handle, prior[1]!.handle];
      chars.value = [[...(prior[0]!.characters ?? [])], [...(prior[1]!.characters ?? [])]];
      return;
    }
    handles.value = item.value?.handles ? [...item.value.handles] : ['', ''];
    chars.value = [[], []];
  },
  { immediate: true },
);

/** Swap the two handles, leaving the characters where they are.
 *
 *  Only the handles move, and that is the entire point. Moving handles AND
 *  characters together would be a no-op — every handle would keep the same
 *  characters and only the stored array order would change. A mis-pairing is
 *  fixed by sliding the handles across stationary characters, because the
 *  characters were read off the bands (screen order) and are already right. */
function swapHandles(): void {
  handles.value = [handles.value[1]!, handles.value[0]!];
}
const sidesComplete = computed(
  () =>
    handles.value.every((h) => h.trim().length > 0) && chars.value.every((list) => list.length > 0),
);

const nameOf = (id: string) => roster.value.find((c) => c.id === id)?.name ?? id;

function addChar(side: number, e: Event): void {
  const el = e.target as HTMLSelectElement;
  const id = el.value;
  el.value = ''; // the select is a picker, not a value holder
  if (!id) return;
  const list = chars.value[side];
  if (list && !list.includes(id)) list.push(id);
}

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

async function post(body: Record<string, unknown>): Promise<void> {
  if (!item.value) return;
  posting.value = true;
  try {
    await $fetch(api('/api/dev/source-review'), {
      method: 'POST',
      body: { id: item.value.id, ...body },
    });
    item.value.saved =
      body.verdict === 'channel'
        ? { verdict: 'channel', channel: body.channel as string }
        : { verdict: body.verdict as 'exclude' | 'sides' };
    // auto-advance to the next unresolved item
    const next = items.value.findIndex((it, i) => i > cursor.value && !it.saved);
    if (next >= 0) cursor.value = next;
  } finally {
    posting.value = false;
  }
}

const exclude = () => post({ verdict: 'exclude' });
const completeSides = () =>
  post({
    verdict: 'sides',
    handles: [...handles.value],
    characters: [[...chars.value[0]], [...chars.value[1]]],
  });

function onKey(e: KeyboardEvent): void {
  const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  // Enter saves from anywhere including the selects — a labelling pass is two
  // dropdowns and a commit, and reaching for the mouse each time is the whole
  // cost of the session.
  if (e.key === 'Enter') {
    if (sidesComplete.value && !posting.value) void completeSides();
    return;
  }
  if (inField) return;
  if (e.key === 'ArrowRight') cursor.value = Math.min(cursor.value + 1, items.value.length - 1);
  else if (e.key === 'ArrowLeft') cursor.value = Math.max(cursor.value - 1, 0);
  else if (e.key === 's') swapHandles();
  else if (e.key === 'x') void exclude();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>
