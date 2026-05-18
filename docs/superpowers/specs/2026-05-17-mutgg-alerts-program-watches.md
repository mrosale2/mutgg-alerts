# mutgg-alerts — Program-wide watches

**Status:** spec, awaiting plan
**Date:** 2026-05-17

## Why

Today, a `mutgg-alerts` watch is one player on one platform. To watch all 18 Golden Tickets you create 18 watches. Matt's current KV state proves the pain: all 5 watches are 99 OVR Golden Ticket on PC, and there are 13 more GT cards he'd ideally also be watching.

A program-wide watch lets one watch cover every card in a program (optionally filtered by minimum OVR), checking each card against its own median price instead of a flat coin number.

## Goals

- One watch covers every card in a named mut.gg program (e.g., `golden-ticket`, `toty`, `flashbacks`).
- Alert rule is *percent-off-median per card*, not a flat coin number. One `pct` value per watch (e.g., 70 = "BIN ≤ 70% of that card's median").
- Optional `minOvr` filter on the watch ("only watch 99 OVR cards in this program").
- Program member lists refresh automatically as mut.gg adds cards to programs.
- Coexist with existing per-player watches — both kinds live in the same KV blob and same UI list.
- Discord alerts identify the specific card that fired, not just the program.

## Non-goals (deferred to later iterations)

- Pagination for very large programs (Flashbacks ~322 cards). v1 handles whatever fits in the program page's first render.
- Cross-platform watches. One platform per watch, same as today.
- Backfilling existing watches with the `kind` discriminator at write time — handled at read time as `kind ?? "player"`.
- Fixing the `recurring`-flag-is-cosmetic bug surfaced during the spike (separate issue).

## Discovery (from the 2026-05-17 devtools spike)

1. **Program URLs** are slug-based: `https://www.mut.gg/programs/<slug>/`. The `/programs/` index lists every program with its player count.
2. **Player list lives in the program page's HTML.** Each player card link matches `/players/\d+-[^/]+/26-(\d+)/` where the captured group is the externalId. The Golden Ticket page returned all 18 externalIds inline.
3. **Bulk medians endpoint already exists:** `GET /api/mutdb/prices/overall/playeritem/?external_ids=<comma-csv>` accepts arbitrary N and returns per-platform medians in one call. Confirmed working with 18 IDs in the spike.
4. **Live auctions remain per-card** — no bulk variant. Same `/api/mutdb/prices/<gameSlug>-<externalId>/<platform>/` endpoint the worker already uses.

## Design

### Watch shape

Add a `kind` discriminator. Existing per-player watches treat missing `kind` as `"player"` (zero-migration read-time defaulting).

**Program watch:**

```ts
{
  id: "program-golden-ticket-pc",        // <kind>-<slug>-<platform>
  kind: "program",
  slug: "golden-ticket",                 // mut.gg URL slug
  programName: "Golden Ticket",          // human label
  platform: "pc" | "xbox-series-x" | "playstation-5",
  pct: 70,                               // alert when BIN ≤ median × (pct/100)
  minOvr: 99 | null,                     // optional OVR floor
  cards: {                               // cached membership, refreshed daily
    [externalId: number]: {
      ovr: number,
      name: string,                      // "Lamar Jackson"
      url: string,                       // "/players/13092-lamar-jackson/26-88013092/"
    }
  },
  cardsRefreshedAt: string,              // ISO timestamp
  lastAlertedPrices: { [externalId: number]: number },  // per-card price memory
  lastChecked: number,                   // ms epoch
  lastError: string | null,
}
```

**Per-player watch (today's shape + `kind` field):**

```ts
{
  kind: "player",                        // NEW; absent = treated as "player"
  // ...all existing fields unchanged
}
```

### Cron path (every-minute trigger, existing `scheduled()`)

1. Load watches blob from KV.
2. Partition by `kind`. Player path: unchanged.
3. For each program watch:
   - **1 subrequest:** `GET /api/mutdb/prices/overall/playeritem/?external_ids=<csv of Object.keys(cards)>` → `Map<externalId, median>`.
   - **N parallel subrequests:** `GET /api/mutdb/prices/<gameSlug>-<externalId>/<platform>/` per card → `cheapestBin`.
   - For each card: skip if `median == null` (insufficient sales data). Otherwise `eligible = cheapestBin <= median * (pct/100)`. If eligible AND (`lastAlertedPrices[externalId]` absent OR `cheapestBin < lastAlertedPrices[externalId]`), fire Discord alert and update `lastAlertedPrices[externalId] = cheapestBin`.
4. Save watches blob to KV (single write, as today).

**Subrequest budget per program watch:** `1 + N + alerts_fired`. For Golden Ticket (N=18): ≤19 typical, peaks at 36 if every card alerts in the same tick. Comfortable under the 1,000-per-invocation paid-plan cap, with room for 10+ concurrent program watches.

### Daily refresh cron (new trigger)

Append a second cron to `wrangler.toml`:

```toml
crons = ["* * * * *", "5 4 * * *"]   # every minute + once daily at 04:05 UTC
```

The `scheduled()` handler branches on `event.cron`. When `cron === "5 4 * * *"`:

1. Load watches, filter to `kind === "program"`.
2. For each: `GET https://www.mut.gg/programs/<slug>/` (with the same `BROWSER_HEADERS` the worker already uses to dodge the bot-shield).
3. Parse the HTML response: extract `{ externalId, ovr, name, url }` per card link. The link gives `externalId` and `url` via `/\/players\/\d+-[^/]+\/26-(\d+)\//g`; `name` comes from the surrounding card text; `ovr` from the per-card `OVR\s+(\d+)` block.
4. If `minOvr` is set: filter to cards meeting the OVR floor.
5. Set `watch.cards = { [id]: { ovr, name, url }, ... }`, `watch.cardsRefreshedAt = new Date().toISOString()`. If the slug returns 404 or zero cards match, leave `watch.cards` as-is and set `lastError`.
6. Save watches once at end.

### HTTP API additions

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/watches/program` | Create or update a program watch. Body: `{ slug, programName, platform, pct, minOvr }`. Worker scrapes the program page synchronously to populate `externalIds` on create (so the watch is immediately useful, doesn't wait for the next daily cron). |
| `GET` | `/api/programs` | List all available programs from mut.gg. First call scrapes `/programs/` and caches result under KV key `programs-index` with a 24h TTL marker; subsequent calls serve from cache. |
| `POST` | `/api/refresh-programs` | Manually trigger the daily-refresh logic. Used in dev + UI "refresh now" button. |

Existing `POST /api/watches` route is unchanged (player watches).

### UI changes (embedded HTML in `worker/src/index.js`)

The add-watch card gets a mode toggle at the top: **Player** (default) | **Program**.

- **Player mode:** existing form, no changes.
- **Program mode:**
  - Program dropdown (populated from `GET /api/programs`)
  - Optional minimum OVR input
  - Platform selector (reused)
  - Target % input (default 70, range 50–95)
  - "Add program watch" button → `POST /api/watches/program`

Alert log entry for a program watch shows:
- Header: `<programName> · <N> cards · ≤<pct>% of median · <platform>` + delete button
- Expand toggle revealing per-card sub-rows for cards that have alerted (most recent first), each showing card name, last-alerted price, last-alerted timestamp
- A "refresh members" link that calls `POST /api/refresh-programs` for just this watch

### Discord alert format (program watches)

```
🎯 <playerName> (<programName>) — <platform>
BIN <fmt(cheapestBin)>  ·  <pct_below>% under median <fmt(median)>
Card link: https://www.mut.gg<playerUrl>
```

The player URL and name come from `watch.cards[externalId]` — no extra fetch at alert time.

### Error handling

| Failure | Behavior |
|---|---|
| Bulk-medians fetch fails | Skip this program watch this tick; persist error to `lastError`; per-player watches in same tick still run. |
| One live-auction fetch fails | Skip just that card; continue processing other cards in the watch. |
| Daily refresh fetch fails | Keep stale `externalIds`; set `lastError`. (Stale is strictly better than empty.) |
| Program slug returns 404 | Same as above. UI shows the error. |
| Card has `median == null` | Skip — can't compute %-off-median. Common for newly-released cards. |

### Testing

- **Unit:** add `worker/tests/` with vitest (new dev dependency — the worker currently has no test framework wired up). First test: the program-page HTML parser. Save a real `/programs/golden-ticket/` HTML response to `worker/tests/fixtures/golden-ticket.html` and assert the parser returns the expected 18 cards with the right externalIds, OVRs, names, and URLs.
- **Manual loop:** `POST /api/poll` already triggers the per-minute cron handler synchronously. Add `POST /api/refresh-programs` for the daily-refresh handler. Both gated by `AUTH_SECRET` like every other API route.
- **Live verification:** seed a Golden Ticket program watch with `pct: 95` so it fires on existing listings within one tick. Confirm Discord receives the per-card alert with the right name + link.

## Implementation sketch (high level — `writing-plans` will phase this)

1. Read-time `kind ?? "player"` defaulting + add `kind: "player"` on every existing-watch save.
2. Program-page HTML parser as a pure function + unit test.
3. `/api/programs` index endpoint with KV cache.
4. `/api/watches/program` create/update endpoint (synchronously scrapes on create).
5. Cron handler split: branch on `event.cron`, add program-watch tick logic.
6. Daily-refresh cron handler + `/api/refresh-programs`.
7. UI: mode toggle + program form + alert-log rendering for program watches.
8. Deploy + live verification with a real GT program watch.

## Open risks

- **Pagination of large programs.** Mitigated by deferring Flashbacks-class programs to a v2. If Matt creates such a watch in v1 he'll get a partial member list — UI should display the count and let him notice.
- **mut.gg HTML structure changes.** The regex on `/players/\d+-[^/]+/26-(\d+)/` is brittle. Mitigation: keep stale `externalIds` on parse failure rather than blowing them away, surface `lastError` prominently in UI.
- **`minOvr` requires OVR extraction from HTML.** The spike confirmed `OVR <N>` text is present in each card block, but the surrounding markup wasn't fully characterized. If the parser proves brittle during implementation, downgrade `minOvr` from required-in-v1 to "best-effort: if OVR extraction fails, watch all cards in the program and emit a warning."
