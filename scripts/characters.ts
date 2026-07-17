// Roster art + data scraper — the bespoke Tekken counterpart of the 2XKO
// champions.ts (entirely different source: Bandai Namco's official Tekken 8
// site, not Riot's CMS). Produces:
//   • public/img/characters/<id>-portrait.webp  (from images/character/<id>/btn.png)
//   • public/img/characters/<id>-splash.webp    (from images/character/<id>/img_01.png)
//   • data/characters.json — id, short display name, art paths, accent
//     (← design/handoff/tokens.css --char-<id>, the source of truth),
//     extra { aliases (parse/search), "full name", japanese }
//
// RE-RUNNABLE for DLC: the roster is discovered from the live site each run;
// existing art is kept unless --force; a roster id without a --char-* token
// fails loudly (add the accent to the design tokens, then re-run).
//
// Run: npm run data:characters   [--force]

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import type { CharacterRecord } from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IMG_DIR = join(ROOT, 'public', 'img', 'characters');
const TOKENS = join(ROOT, 'design', 'handoff', 'tokens.css');
const SITE = 'https://tk8.tekken-official.jp';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) tekken-replay-database roster scraper (fan project)';
const FORCE = process.argv.includes('--force');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}
async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── display names: short common names (chips/filters/parse), with the
//    official full EN + JP names kept in `extra` for the character page ──────
const SHORT_NAME_OVERRIDES: Record<string, string> = {
  jack8: 'Jack-8',
};
const shortName = (id: string): string =>
  SHORT_NAME_OVERRIDES[id] ??
  id
    .split('_')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

// Curated title-parse aliases (beyond the automatic short/full names):
// leetspeak-free common variants + typos the tracked channels actually use.
const CURATED_ALIASES: Record<string, string[]> = {
  alisa: ['alisa bosconovitch'],
  anna: ['anna williams'],
  armor_king: ['armorking', 'armour king'],
  asuka: ['asuka kazama'],
  bryan: ['bryan fury'],
  claudio: ['claudio serafino'],
  clive: ['clive rosfield'],
  devil_jin: ['deviljin', 'dvj'],
  dragunov: ['sergei dragunov', 'sergei'],
  eddy: ['eddy gordo'],
  fahkumram: ['fakumram', 'fahkurmram'],
  feng: ['feng wei'],
  heihachi: ['heihachi mishima'],
  hwoarang: ['howarang', 'hworang'],
  jack8: ['jack-8', 'jack 8', 'jack'],
  jin: ['jin kazama'],
  jun: ['jun kazama'],
  kazuya: ['kazuya mishima'],
  kunimitsu: ['kuni'],
  lars: ['lars alexandersson'],
  law: ['marshall law'],
  lee: ['lee chaolan', 'violet'],
  leroy: ['leroy smith'],
  lidia: ['lidia sobieska'],
  lili: ['emilie de rochefort'],
  miary_zo: ['miaryzo', 'miary'],
  nina: ['nina williams'],
  paul: ['paul phoenix'],
  steve: ['steve fox'],
  victor: ['victor chevalier'],
  xiaoyu: ['ling xiaoyu'],
  yoshimitsu: ['yoshi'],
  zafina: [],
};

// ── roster discovery from the official site ─────────────────────────────────
interface RosterEntry {
  id: string;
  fullName: string; // official EN, e.g. 'Kazuya Mishima'
  nameJa: string; // official JP, e.g. '三島 一八'
}

async function discoverRoster(): Promise<RosterEntry[]> {
  // The character index carries the full roster grid (ids + JP alt text);
  // official EN names render only on each character's own page, in the
  // carousel's `current` block: <li class="current"><p><span>EN</span><span>JP</span></p>.
  const index = await fetchText(`${SITE}/character/`);
  const ids = [
    ...new Set([...index.matchAll(/images\/character\/([a-z0-9_]+)\/btn\.png/g)].map((m) => m[1]!)),
  ].sort();
  if (ids.length < 30) throw new Error(`roster discovery looks broken: only ${ids.length} ids`);

  const out: RosterEntry[] = [];
  for (const id of ids) {
    const page = await fetchText(`${SITE}/character/index.php?chara=${id}`);
    const m = /<li class="current"><p><span>([^<]+)<\/span><span>([^<]+)<\/span><\/p><\/li>/.exec(
      page,
    );
    if (!m) throw new Error(`no official name block on the ${id} page — markup changed?`);
    out.push({ id, fullName: m[1]!.trim(), nameJa: m[2]!.trim() });
    await sleep(200); // be polite to the official site
  }
  return out;
}

// ── accents from the design tokens (source of truth; PLAN §4a) ───────────────
async function loadAccents(): Promise<Record<string, string>> {
  const css = await readFile(TOKENS, 'utf8');
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--char-([a-z0-9_]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

// ── art download + webp optimization (sharp) ─────────────────────────────────
async function processArt(id: string): Promise<{ portrait: string; splash: string }> {
  const portraitOut = join(IMG_DIR, `${id}-portrait.webp`);
  const splashOut = join(IMG_DIR, `${id}-splash.webp`);
  if (FORCE || !existsSync(portraitOut)) {
    const buf = await fetchBuffer(`${SITE}/images/character/${id}/btn.png`);
    await sharp(buf).resize({ width: 512 }).webp({ quality: 82 }).toFile(portraitOut);
    await sleep(250); // be polite to the official site
  }
  if (FORCE || !existsSync(splashOut)) {
    const buf = await fetchBuffer(`${SITE}/images/character/${id}/img_01.png`);
    await sharp(buf)
      .resize({ width: 1000, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(splashOut);
    await sleep(250);
  }
  return {
    portrait: `/img/characters/${id}-portrait.webp`,
    splash: `/img/characters/${id}-splash.webp`,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
await mkdir(IMG_DIR, { recursive: true });
const roster = await discoverRoster();
console.log(`Roster discovered: ${roster.length} characters`);

const accents = await loadAccents();
const missingAccents = roster.filter((r) => !accents[r.id]).map((r) => r.id);
if (missingAccents.length > 0) {
  console.error(
    `✖ design/handoff/tokens.css has no --char-* accent for: ${missingAccents.join(', ')}\n` +
      '  Add the token(s) — the design system is the accent source of truth — then re-run.',
  );
  process.exit(1);
}

const characters: CharacterRecord[] = [];
for (const entry of roster) {
  const name = shortName(entry.id);
  const art = await processArt(entry.id);
  const aliases = [
    ...new Set(
      [name.toLowerCase(), entry.fullName.toLowerCase(), ...(CURATED_ALIASES[entry.id] ?? [])].map(
        (a) => a.trim(),
      ),
    ),
  ];
  characters.push({
    id: entry.id,
    name,
    imgPortrait: art.portrait,
    imgSplash: art.splash,
    accent: accents[entry.id]!,
    extra: { aliases, 'full name': entry.fullName, japanese: entry.nameJa },
  });
  console.log(
    `  ✔ ${entry.id} → ${name} (${entry.fullName} / ${entry.nameJa}) ${accents[entry.id]}`,
  );
}

await writeFile(
  join(ROOT, 'data', 'characters.json'),
  JSON.stringify(characters, null, 2) + '\n',
  'utf8',
);
console.log(`✔ Wrote data/characters.json (${characters.length} characters)`);
