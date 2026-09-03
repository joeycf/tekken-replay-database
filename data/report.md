# Tekken pipeline report

**15483 matches** parsed from 25468 uploads across 5 channels, plus 317 from 1 index · 2593 players · ranked sides 13747/30966 (44.4%)

| channel | source | uploads | parsed | coverage |
| --- | --- | ---: | ---: | ---: |
| highLevel | highLevel | 4582 | 4549 | 99.3% |
| telly | telly | 12632 | 7718 | 61.1% |
| ranked | ranked | 2624 | 2603 | 99.2% |
| bneEsports | tournament | 2866 | 233 | 8.1% |
| evoEvents | tournament | 2764 | 63 | 2.3% |
| replayTheater _(carried)_ | tournament | — | 317 | — |

### Index intakes

Fetched by the daily cron since 2026-09-02, and ADD-ONLY: a committed record is
carried whether or not the catalogue still lists it, so this count can only rise.
The cron does not depend on the pull succeeding — on any failure there is no dump,
the committed records are carried, and the run stays green.

| intake | records | pin | this run | pages | new | not in this pull |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| `replayTheater` | 317 | 317 | carried (pull found no new tournament entries) | — | — | — |

_The pull ran and found no new tournament entries, so the committed catalogue_
_was carried unchanged and this pull's intake counts were not measured._
_The cursor still advanced: a quiet day is the ordinary case here, not a_
_failed one — the catalogue's tagged Tekken rows stop at 2025-03-16._

Seasons: S1 6359 · S2 6058 · S3 3066

Patches: 1.01 578 · 1.02 560 · 1.03 470 · 1.04 676 · 1.05 588 · 1.06 658 · 1.07 354 · 1.08 453 · 1.09 709 · 1.10 385 · 1.11 440 · 1.12 245 · 1.13 243 · 2.00 876 · 2.01 479 · 2.02 682 · 2.03 515 · 2.04 467 · 2.05 736 · 2.06 865 · 2.08 1437 · 3.00 1287 · 3.01 1494 · 3.02 276 · unknown 10 (unknown = season contradicts the date: label-grace/override)

Misses by reason: pre-launch 4456 · not-tekken8 2629 · short-duration 1683 · shorts 1125 · no-vs-title 246 · char-unresolved 158 · bad-handle 3 · live-or-upcoming 2

Season-label conflicts (channel label ≠ date-derived season, outside the ±14d boundary grace; date wins): 146

Pending review: 0 (data/review-queue.json)

Player identity: 109 identity(s) resolved from more than one spelling

Retired ids are 301-redirected from vercel.json — run `npm run data:redirects`
after changing scripts/players.ts, or the old URLs 404.

- `afroking` ← `afro-king`
- `aimedtwo` ← `aimed-two`
- `ayorichie` ← `ayo-richie`
- `baek-mai` ← `baekmai`
- `bare-chi` ← `barechi`
- `bigboss` ← `big-boss`
- `binch-anhap` ← `binchanhap`
- `blueberrymango` ← `blue-berry-mango`
- `brawlpro` ← `brawl-pro`
- `bryantheory` ← `bryan-theory`
- `cd-gken` ← `cdgken`
- `cheeseyoni` ← `cheese-yoni`
- `cherry-berry-mango` ← `cherryberrymango`
- `crazy-dongpal` ← `crazy-dong-pal` · `crazydongpal`
- `cuddle-core` ← `cuddlecore`
- `d-f-p` ← `dfp`
- `d-porsche` ← `dporsche`
- `daddyking` ← `daddy-king`
- `dal-bit` ← `dalbit`
- `dalbit06` ← `dal-bit06`
- `danielmado` ← `daniel-mado`
- `deathrow` ← `death-row`
- `devilbuu` ← `devil-buu`
- `dhome50` ← `dhome-50`
- `dirtystyle` ← `dirty-style`
- `divine-exorcist` ← `divineexorcist`
- `drking` ← `dr-king`
- `dxmusalli` ← `dx-musalli`
- `el-toro-alba` ← `eltoro-alba`
- `endlessaffect` ← `endless-affect`
- `gbob` ← `g-bob`
- `go-attack` ← `goattack`
- `gogo-attacker` ← `go-go-attacker`
- `help-me` ← `helpme`
- `heybroken` ← `hey-broken`
- `hidetone` ← `hide-tone`
- `hk-47-tk` ← `hk47tk`
- `how-foolish` ← `howfoolish`
- `imyourfather` ← `i-m-your-father` · `im-your-father`
- `jacobkaas` ← `jacob-kaas`
- …and 69 more

## Replay Theater cross-check

An independent reading of **7055** of our own records, from the catalogue's
UNTAGGED entries — online replays it indexes that we also parse from a tracked
channel. Neither side saw the other, so this is the only accuracy number here the
pipeline did not produce about itself. It changes nothing: a disagreement is
recorded in data/theater-disagreements.json with both claims, never written into
a record. The catalogue does not outrank a confident parse and never outranks a
human override.

_Measured on the last full sweep, at catalogue entry 488393. 3889 catalogue entr(ies) point at videos_
_we do not hold; 0 are VODs the catalogue segments, which the intake owns._

| field | population | agree | partial | disagree | cannot witness |
| --- | ---: | ---: | ---: | ---: | ---: |
| players (both handles) | 7055 | 7040 (99.79%) | 13 | 2 | — |
| characters (per side) | 14110 | 13774 (97.62%) | 0 | 3 (0.02%) | 333 |

Side order differed on **0** record(s); the comparison realigns on the
handles before reading characters, so a swapped pair is not counted twice as a
character disagreement.

**333** side(s) the catalogue COULD NOT HAVE GOT RIGHT are held out of both
columns above: agreement over the 13777 it can express is **99.98%**.

Its vocabulary has no word for these, derived from that sweep rather than declared —
no string anywhere in the pull resolves to the id, and where we say it the
catalogue says one particular other thing almost every time:

- `armor_king` → the catalogue writes `king` instead, on 332 of the 333 side(s) where we say it (99.70%).

Of the 17 side(s) whose handles did not match, **6** are ours carrying extra text
the catalogue does not, **2** are theirs carrying a team tag ORG_PREFIXES does not
list yet, and **9** are genuinely different names — the only bucket worth reading one
row at a time. Reported, never scored: substring matching on handles is the kind of
guessing this module refuses.

**5 disagreement(s)** — both claims, ours first:

- `S2TWIGBSVm8` players: **lowhigh, doma** vs catalogue **knee, nobi** — T8 ▰ LOWHIGH (#1 Ranked Bryan) Vs DOMA (Armor King) ▰ Tekken 8 High Le
- `AntIuY2IcIc` side 0 characters: **clive** vs catalogue **bryan** — T8 ▰ CRESCENT (#1 Ranked Clive) Vs NABDO (#5 Ranked Yoshimitsu) ▰ Tekk
- `NSXnX3i2wqs` side 1 characters: **leo** vs catalogue **lee** — T8 ▰ CHIKURIN (King) Vs DOKUZU (Leo) ▰ Tekken 8 High Level Gameplay
- `QHm_fVLi9cE` side 1 characters: **heihachi** vs catalogue **kuma** — Tekken 8 ▰ BUPPAMEN (#4 Ranked Steve Fox) Vs NEVER1997 (Akuma Heihachi
- `ufmR0DPqxFM` players: **speedkicks, tone** vs catalogue **skjr, hidetone** — Tekken 8 ▰ SPEEDKICKS (#1 Ranked Heihachi) Vs TONE (Bryan) ▰ High Leve

## Sample misses (first 30 that are not shorts/live)

- `R0uPm8YbWbQ` [highLevel] char-unresolved: T8 🔥 CBM (#2 Ranked Jin / Clive) vs KEISUKE (#1 Ranked Kazuya) 🔥 Tekken 8 High Level Gameplay
- `PZF_VI4yDPk` [highLevel] char-unresolved: T8 🔥 BREADMAN (Heihachi / Bryan) vs CHANEL (Anna) 🔥 Tekken 8 High Level Gameplay
- `N7VzjjXmySY` [highLevel] char-unresolved: T8 🔥 KNEE (Lidia / Law / Leo) vs SODAM (Xiaoyu) 🔥 Tekken 8 High Level Gameplay
- `jv6Sojug6y4` [highLevel] char-unresolved: T8 🔥 ULSAN (Shaheen/Dragunov) vs EDGE (#1 Ranked Hwoarang) 🔥 Tekken 8 High Level Gameplay
- `zStR4iSwD4Y` [highLevel] char-unresolved: T8 🔥 JOKA (#1 Ranked Heihachi) vs K-WISS (#2 Ranked Hwoarang / Heihachi) 🔥 High Level Gameplay
- `cyOQeWzE3-Y` [highLevel] no-vs-title: T8 🔥 First Look at KNEE’s Heihachi 🔥 Tekken 8 Day One Heihachi Mishima
- `67ek5MURxC8` [highLevel] no-vs-title: T8 🔥 MEO-IL (#2 Ranked Jack-8) 🔥 Tekken 8 High Level Gameplay
- `njnVq4oibfM` [highLevel] char-unresolved: T8 🔥 BREADMAN (#1 Ranked Leroy / Dragunov) vs JUSTICE (#4 Ranked Paul) 🔥 T8 High Level Gameplay
- `Ihvhj4m3tZI` [highLevel] no-vs-title: T8 🔥 Anakin + Lidia! 🔥 Tekken 8 Lidia Sobieski Day 2
- `uNAGsvJ6RhA` [highLevel] no-vs-title: T8 🔥 Ulsan (4th place at EVO 2024) + Lidia! 🔥 Tekken 8 Lidia Sobieski Day 2
- `ea--S8NkK0g` [highLevel] no-vs-title: T8 🔥 Breadman (#1 Ranked Leroy) tries out Lidia 🔥 Tekken 8 Lidia Sobieski Day 1
- `fG4DqeTHiLU` [highLevel] char-unresolved: T8 🔥 JeonDDing (Eddy/Reina) vs JDCR (Dragunov) 🔥 Tekken 8 High Level Gameplay
- `6Ms4Ml7_iTU` [highLevel] no-vs-title: T8 🔥 JeonDDing' unstoppable Eddy! 🔥 Tekken 8 High Level Gameplay
- `a8Agax5NUFA` [highLevel] bad-handle: T8 🔥 Jeondding (Eddy) vs 이새낀 닌자 그 자체 (#2 Ranked Raven) 🔥 Tekken 8 High Level Gameplay
- `p7IrMkQuFYU` [highLevel] no-vs-title: T8 🔥 JeonDDing's Eddy Gordo is INSANE!  🔥 Tekken 8 High Level Gameplay
- `tyABfxhl5Cg` [highLevel] no-vs-title: T8 🔥 Anakin (Eddy) First look! 🔥 Tekken 8 High Level Gameplay
- `wOyY-wl5hXs` [highLevel] no-vs-title: T8 🔥 Rangchu (Eddy) vs Mulgold & Noob King & Gupimon 🔥 Tekken 8 High Level Gameplay
- `e5gRNIrMW2E` [highLevel] no-vs-title: T8 🔥 JeonDDing (Eddy Gordo) First look! 🔥 Tekken 8 High Level Gameplay
- `Acl6yLISNgg` [highLevel] no-vs-title: T8 🔥 Rangchu (Eddy Gordo) First look! 🔥 Tekken 8 High Level Gameplay
- `MouW4DmD5UI` [highLevel] bad-handle: T8 🔥 CherryBerryMango (Jin) vs 티슈몽핀야고어택딸기잼임모탈 (#2 Ranked Raven) 🔥 Tekken 8 High Level Gameplay
- `9sVgDD3Irb4` [highLevel] bad-handle: T8 🔥 Knee (#1 Ranked Bryan) vs 어질고여유로운좋은사람웨까 (Xiaoyu) 🔥 Tekken 8
- `oDduomUp5gM` [highLevel] char-unresolved: T8 🔥 Nobi (Dragunov) vs Kkokkoma (Kazuya/Azucena) 🔥 Tekken 8
- `TuAyTkYu9js` [highLevel] char-unresolved: T8 🔥 AK (Shaheen) vs Dee-On Grey (Jack8) 🔥 Tekken 8
- `S7axjc3hncM` [highLevel] no-vs-title: T8 🔥 Nino (Panda) 🔥 Tekken 8
- `GAUiaon1X9s` [highLevel] no-vs-title: T8 🔥 Knee (Azucena) 🔥 Tekken 8
- `LFOlha2Us7I` [highLevel] no-vs-title: T8 🔥 LowHigh (Shaheen) 🔥 Tekken 8
- `koClRVWZtig` [highLevel] no-vs-title: T8 🔥 NinjaKilla's Law (Mortal Kombat Evo Champion!) 🔥 Tekken 8
- `NntsN9zKgK0` [highLevel] no-vs-title: T8 🔥 Super Akouma (Lee) 🔥 Tekken 8
- `4Pf63UozmxA` [highLevel] no-vs-title: T8 🔥 Kkokkoma (Dragunov) 🔥 Tekken 8
- `RUDWRC5M738` [highLevel] no-vs-title: T8 🔥 Shadow 20z (Zafina) 🔥 Tekken 8

_Generated 2026-09-03T01:52:29.455Z_
