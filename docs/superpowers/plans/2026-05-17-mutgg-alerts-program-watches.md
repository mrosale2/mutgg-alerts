# Program-wide Watches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kind: "program"` watch type that covers every card in a named mut.gg program at a per-card percent-off-median target price, with a daily-refreshed member list.

**Architecture:** Extend the existing single-blob KV `watches` store with a `kind` discriminator (`"player"` or `"program"`). The every-minute `scheduled()` cron partitions watches by kind and runs the existing player path unchanged, plus a new program path that (1) bulk-fetches medians for all cards in one call, (2) per-card fetches live auctions, and (3) fires per-card Discord alerts when `BIN ≤ median × pct/100` AND strictly cheaper than the last per-card alerted price. A second cron (`5 4 * * *`) refreshes program member lists daily by scraping `/programs/<slug>/` HTML.

**Tech Stack:** Cloudflare Workers (paid plan), Workers KV, Discord webhooks, Vitest (new), plain JS (no TypeScript build).

**Spec:** [docs/superpowers/specs/2026-05-17-mutgg-alerts-program-watches.md](../specs/2026-05-17-mutgg-alerts-program-watches.md)

---

## File Structure

```
worker/
├── src/
│   ├── index.js                       # MODIFY: cron split, API additions, UI changes
│   └── parse-program-page.js          # CREATE: pure parser for /programs/<slug>/ HTML
├── tests/
│   ├── parse-program-page.test.js     # CREATE: parser unit tests
│   ├── parse-programs-index.test.js   # CREATE: index parser unit tests
│   └── fixtures/
│       ├── golden-ticket.html         # CREATE: real /programs/golden-ticket/ HTML
│       └── programs-index.html        # CREATE: real /programs/ HTML
├── vitest.config.js                   # CREATE: minimal vitest config
├── package.json                       # MODIFY: add vitest, add `test` script
└── wrangler.toml                      # MODIFY: add daily cron
```

Decisions worth knowing:
- The parser lives in its own file so it's testable as a pure function with no Workers runtime dependency. Everything else stays in `index.js` to keep the diff small and match the existing single-file convention.
- Vitest works fine on plain JS files; no build step needed. ESM by default (matches the worker's `export default {}` style).
- Fixtures are real captured HTML, not synthesized — guarantees the parser handles mut.gg's actual markup quirks (e.g., the trailing space in `class="player-list-item__name-last "`).

---

## Task 1: Wire up Vitest

**Files:**
- Modify: `worker/package.json`
- Create: `worker/vitest.config.js`
- Create: `worker/tests/smoke.test.js`

- [ ] **Step 1: Install vitest as a dev dependency**

Run from `worker/`:
```bash
npm install -D vitest@^2.0.0
```
Expected: `package-lock.json` and `node_modules/vitest/` exist; no errors.

- [ ] **Step 2: Add a `test` script + commit-clean package.json**

Edit `worker/package.json`. The `scripts` block becomes:
```json
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail",
    "test": "vitest run",
    "test:watch": "vitest",
    "kv:create": "wrangler kv namespace create WATCHES",
    "secret:webhook": "wrangler secret put DISCORD_WEBHOOK",
    "secret:auth": "wrangler secret put AUTH_SECRET"
  },
```

- [ ] **Step 3: Create a minimal vitest config**

Create `worker/vitest.config.js`:
```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Write a smoke test**

Create `worker/tests/smoke.test.js`:
```js
import { describe, it, expect } from 'vitest';

describe('vitest wiring', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

Run from `worker/`:
```bash
npm test
```
Expected: `Test Files  1 passed (1)` and exit 0.

- [ ] **Step 6: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/vitest.config.js worker/tests/smoke.test.js
git commit -m "chore(worker): wire up vitest for unit tests"
```

---

## Task 2: Program-page HTML parser (TDD)

**Files:**
- Create: `worker/tests/fixtures/golden-ticket.html`
- Create: `worker/tests/parse-program-page.test.js`
- Create: `worker/src/parse-program-page.js`

The parser turns `/programs/<slug>/` HTML into `{ [externalId]: { ovr, name, url } }`. mut.gg's markup anchors per card:
- Each card is wrapped in `<a href="/players/<idnum>-<slug>/26-<externalId>/" class="player-list-item__link">`
- Within the block:
  - OVR: `<div class="player-list-item__score-value">\s*<NN>\s*</div>`
  - First name: `<div class="player-list-item__name-first"><name></div>`
  - Last name: `<div class="player-list-item__name-last <space>"><name></div>` (trailing space in class is real, observed in actual markup)

- [ ] **Step 1: Capture the fixture**

Run from repo root:
```bash
curl -s -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  https://www.mut.gg/programs/golden-ticket/ \
  -o worker/tests/fixtures/golden-ticket.html
wc -c worker/tests/fixtures/golden-ticket.html
```
Expected: file size > 50000 bytes. If you get `0` or HTML containing the word "Cloudflare" challenge, retry with a real browser-class user agent.

- [ ] **Step 2: Write the failing test**

Create `worker/tests/parse-program-page.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseProgramPage } from '../src/parse-program-page.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'fixtures/golden-ticket.html'), 'utf8');

describe('parseProgramPage (Golden Ticket fixture)', () => {
  const cards = parseProgramPage(html);
  const ids = Object.keys(cards).map(Number).sort((a, b) => a - b);

  it('extracts all 18 cards keyed by externalId', () => {
    expect(ids.length).toBe(18);
  });

  it('parses Lamar Jackson correctly', () => {
    expect(cards[88013092]).toEqual({
      ovr: 99,
      name: 'Lamar Jackson',
      url: '/players/13092-lamar-jackson/26-88013092/',
    });
  });

  it('parses Randy Moss correctly', () => {
    expect(cards[88001762]).toEqual({
      ovr: 99,
      name: 'Randy Moss',
      url: '/players/1762-randy-moss/26-88001762/',
    });
  });

  it('parses Joe Milton III (multi-word last name)', () => {
    expect(cards[88014614]).toEqual({
      ovr: 99,
      name: 'Joe Milton III',
      url: '/players/32850-joe-milton-iii/26-88014614/',
    });
  });

  it('every card has OVR >= 80 (sanity)', () => {
    for (const id of ids) {
      expect(cards[id].ovr).toBeGreaterThanOrEqual(80);
    }
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run from `worker/`:
```bash
npm test -- tests/parse-program-page.test.js
```
Expected: FAIL with "Cannot find module '../src/parse-program-page.js'".

- [ ] **Step 4: Implement the parser**

Create `worker/src/parse-program-page.js`:
```js
// Parses a mut.gg /programs/<slug>/ HTML response into a map of
// { [externalId]: { ovr, name, url } }. Pure function, no I/O.
//
// Anchors on these BEM-style classes that mut.gg uses on each card:
//   <a href="/players/<idnum>-<slug>/26-<externalId>/" class="player-list-item__link">
//     ...
//     <div class="player-list-item__score-value"> <OVR> </div>
//     ...
//     <div class="player-list-item__name-first"> <First> </div>
//     <div class="player-list-item__name-last "> <Last> </div>   // trailing space is real
//   </a>

const LINK_RE = /<a\s+href="(\/players\/\d+-[^"]+\/26-(\d+)\/)"\s+class="player-list-item__link"/g;
const OVR_RE   = /class="player-list-item__score-value"\s*>\s*(\d+)\s*</;
const FIRST_RE = /class="player-list-item__name-first"\s*>\s*([^<]+?)\s*</;
const LAST_RE  = /class="player-list-item__name-last\s*"\s*>\s*([^<]+?)\s*</;

export function parseProgramPage(html) {
  const cards = {};
  const matches = [...html.matchAll(LINK_RE)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const url = m[1];
    const externalId = Number(m[2]);

    // Slice up to the next card link (or end of file) so each card's fields
    // only match within its own block.
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const block = html.slice(start, end);

    const ovrMatch = block.match(OVR_RE);
    const firstMatch = block.match(FIRST_RE);
    const lastMatch = block.match(LAST_RE);

    if (!ovrMatch || !firstMatch || !lastMatch) continue;

    cards[externalId] = {
      ovr: Number(ovrMatch[1]),
      name: `${firstMatch[1]} ${lastMatch[1]}`.replace(/\s+/g, ' ').trim(),
      url,
    };
  }

  return cards;
}
```

- [ ] **Step 5: Run tests to confirm they pass**

Run from `worker/`:
```bash
npm test -- tests/parse-program-page.test.js
```
Expected: all 5 assertions pass, exit 0. If "Joe Milton III" fails on the last-name match, check whether mut.gg renders multi-segment last names differently — the test reflects current observed reality but the parser may need a wider `LAST_RE` if the markup nests the suffix.

- [ ] **Step 6: Commit**

```bash
git add worker/tests/fixtures/golden-ticket.html worker/tests/parse-program-page.test.js worker/src/parse-program-page.js
git commit -m "feat(worker): add program-page HTML parser with vitest coverage"
```

---

## Task 3: Programs-index parser (TDD)

The `/programs/` index lists every program with its player count. We parse it once and cache the list in KV so the UI's program dropdown is instant.

**Files:**
- Create: `worker/tests/fixtures/programs-index.html`
- Create: `worker/tests/parse-programs-index.test.js`
- Modify: `worker/src/parse-program-page.js` (add second export)

Observed markup pattern from the spike (one entry per program):
```html
<a href="/programs/golden-ticket/">
  Golden Ticket
                        18 Players
</a>
```

- [ ] **Step 1: Capture the fixture**

```bash
curl -s -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  https://www.mut.gg/programs/ \
  -o worker/tests/fixtures/programs-index.html
wc -c worker/tests/fixtures/programs-index.html
```
Expected: file size > 30000 bytes.

- [ ] **Step 2: Write the failing test**

Create `worker/tests/parse-programs-index.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseProgramsIndex } from '../src/parse-program-page.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'fixtures/programs-index.html'), 'utf8');

describe('parseProgramsIndex', () => {
  const programs = parseProgramsIndex(html);

  it('returns a non-empty array', () => {
    expect(programs.length).toBeGreaterThan(10);
  });

  it('includes Golden Ticket with 18 players', () => {
    const gt = programs.find(p => p.slug === 'golden-ticket');
    expect(gt).toBeDefined();
    expect(gt.name).toBe('Golden Ticket');
    expect(gt.count).toBe(18);
  });

  it('every entry has slug, name, count', () => {
    for (const p of programs) {
      expect(typeof p.slug).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(typeof p.count).toBe('number');
      expect(p.slug.length).toBeGreaterThan(0);
    }
  });

  it('dedupes (no duplicate slugs)', () => {
    const slugs = programs.map(p => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
npm test -- tests/parse-programs-index.test.js
```
Expected: FAIL — `parseProgramsIndex` not exported.

- [ ] **Step 4: Add the parser export**

Append to `worker/src/parse-program-page.js`:
```js
// Parses /programs/ HTML into [{ slug, name, count }, ...].
//
// Observed markup pattern (one entry per program):
//   <a href="/programs/<slug>/">
//     <Name>
//     <N> Players
//   </a>

const INDEX_RE = /<a\s+href="\/programs\/([^/"]+)\/"\s*>([\s\S]*?)<\/a>/g;
const COUNT_RE = /(\d+)\s+Players?/;

export function parseProgramsIndex(html) {
  const seen = new Set();
  const programs = [];

  for (const m of html.matchAll(INDEX_RE)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    if (slug === '') continue;   // skip the /programs/ self-link

    const inner = m[2];
    const countMatch = inner.match(COUNT_RE);
    if (!countMatch) continue;   // skip nav links that aren't actual program tiles

    // Name is the text before the count line; strip tags + whitespace.
    const name = inner
      .replace(/<[^>]*>/g, '')
      .replace(/\d+\s+Players?/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!name) continue;

    seen.add(slug);
    programs.push({ slug, name, count: Number(countMatch[1]) });
  }

  return programs;
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm test
```
Expected: both test files pass.

- [ ] **Step 6: Commit**

```bash
git add worker/tests/fixtures/programs-index.html worker/tests/parse-programs-index.test.js worker/src/parse-program-page.js
git commit -m "feat(worker): parse /programs/ index page"
```

---

## Task 4: Add `kind` discriminator with read-time defaulting

We add a `kind` field to every watch. Existing watches in KV don't have it — handle that with read-time defaulting so we don't need a migration script.

**Files:**
- Modify: `worker/src/index.js` (around the `loadWatches` / `saveWatches` helpers + the player-watch POST handler)

- [ ] **Step 1: Add read-time defaulting to `loadWatches`**

Find `loadWatches` in `worker/src/index.js` (~line 81). Replace the function with:
```js
async function loadWatches(env) {
  const raw = await env.WATCHES.get('watches');
  if (!raw) return {};
  const watches = JSON.parse(raw);
  // Read-time migration: legacy watches predate the `kind` field.
  for (const id of Object.keys(watches)) {
    if (!watches[id].kind) watches[id].kind = 'player';
  }
  return watches;
}
```

- [ ] **Step 2: Add `kind: 'player'` to the player-watch POST handler**

Find the `if (req.method === 'POST' && path === '/api/watches')` block (~line 215). In the `watches[id] = { ... }` assignment, add `kind: 'player',` as the first property:
```js
    watches[id] = {
      kind: 'player',
      id, externalId, gameSlug: gameSlug || '26', url: playerUrl, name, program, ovr,
      platform,
      targetBin: targetBin == null ? null : Number(targetBin),
      recurring: !!recurring,
      lastChecked: watches[id]?.lastChecked || 0,
      lastError:   null,
      lastAlertedAt: watches[id]?.lastAlertedAt || null,
      lastAlertedPrice: watches[id]?.lastAlertedPrice || null,
    };
```

- [ ] **Step 3: Verify by deploying to dev**

From `worker/`:
```bash
npm run dev
```
In another shell:
```bash
curl -s http://localhost:8787/api/watches -H "X-Auth: <your-AUTH_SECRET>" | head -c 500
```
Expected: every watch in the response has `"kind":"player"`. Stop the dev server (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker): add kind discriminator with read-time defaulting"
```

---

## Task 5: GET /api/programs endpoint with KV cache

The UI needs a program dropdown. Fetch + cache once per day.

**Files:**
- Modify: `worker/src/index.js`

- [ ] **Step 1: Add `fetchProgramsIndex` helper**

Add near the other fetchers (~line 75, after `fetchOverallPrices`):
```js
async function fetchProgramsIndex() {
  const r = await fetch(`${MUTGG}/programs/`, { headers: BROWSER_HEADERS });
  if (!r.ok) throw new Error(`/programs/: HTTP ${r.status}`);
  return await r.text();
}
```

- [ ] **Step 2: Import the parser**

At the top of `worker/src/index.js` (above `const MUTGG`), add:
```js
import { parseProgramPage, parseProgramsIndex } from './parse-program-page.js';
```

- [ ] **Step 3: Add the `/api/programs` route**

Inside `handleApi`, after the `/api/snapshot` block (~line 270), add:
```js
  // List all mut.gg programs (slug + name + card count). Cached in KV for 24h.
  if (req.method === 'GET' && path === '/api/programs') {
    const cached = await env.WATCHES.get('programs-index', { type: 'json' });
    const now = Date.now();
    if (cached && (now - cached.fetchedAt) < 24 * 60 * 60 * 1000) {
      return jsonResponse({ programs: cached.programs, fromCache: true });
    }
    try {
      const html = await fetchProgramsIndex();
      const programs = parseProgramsIndex(html);
      await env.WATCHES.put('programs-index', JSON.stringify({ fetchedAt: now, programs }));
      return jsonResponse({ programs, fromCache: false });
    } catch (e) {
      // If fetch fails but we have stale cache, return it anyway.
      if (cached) return jsonResponse({ programs: cached.programs, fromCache: true, staleError: String(e.message || e) });
      return jsonResponse({ error: String(e.message || e) }, { status: 502 });
    }
  }
```

- [ ] **Step 4: Verify end-to-end**

From `worker/`:
```bash
npm run dev
```
In another shell:
```bash
curl -s "http://localhost:8787/api/programs" -H "X-Auth: <your-AUTH_SECRET>" | head -c 400
```
Expected: JSON with a `programs` array of `{slug, name, count}` objects including `golden-ticket`. First call is `"fromCache":false`; second is `"fromCache":true`.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker): GET /api/programs with 24h KV cache"
```

---

## Task 6: POST /api/watches/program endpoint

Creates/updates a program watch; synchronously scrapes the program page so the watch is immediately useful.

**Files:**
- Modify: `worker/src/index.js`

- [ ] **Step 1: Add `fetchProgramPage` helper**

Near `fetchProgramsIndex`:
```js
async function fetchProgramPage(slug) {
  const r = await fetch(`${MUTGG}/programs/${slug}/`, { headers: BROWSER_HEADERS });
  if (!r.ok) throw new Error(`/programs/${slug}/: HTTP ${r.status}`);
  return await r.text();
}
```

- [ ] **Step 2: Add the route handler**

Inside `handleApi`, after the `/api/programs` block, add:
```js
  // Create or update a program watch.
  if (req.method === 'POST' && path === '/api/watches/program') {
    const body = await req.json();
    const { slug, programName, platform, pct, minOvr } = body;
    if (!slug || !platform || pct == null) {
      return jsonResponse({ error: 'missing slug, platform, or pct' }, { status: 400 });
    }
    const pctNum = Number(pct);
    if (!(pctNum > 0 && pctNum <= 100)) {
      return jsonResponse({ error: 'pct must be in (0, 100]' }, { status: 400 });
    }
    const minOvrNum = minOvr == null || minOvr === '' ? null : Number(minOvr);

    const id = `program-${slug}-${platform}`;
    const watches = await loadWatches(env);
    const prior = watches[id];

    // Scrape members synchronously so the watch is useful from tick 1.
    let cards;
    try {
      const html = await fetchProgramPage(slug);
      const parsed = parseProgramPage(html);
      cards = minOvrNum == null
        ? parsed
        : Object.fromEntries(Object.entries(parsed).filter(([, c]) => c.ovr >= minOvrNum));
    } catch (e) {
      return jsonResponse({ error: `failed to fetch program members: ${e.message}` }, { status: 502 });
    }

    if (Object.keys(cards).length === 0) {
      return jsonResponse({ error: 'no cards matched (slug invalid or minOvr too high)' }, { status: 400 });
    }

    watches[id] = {
      kind: 'program',
      id, slug, programName: programName || slug, platform,
      pct: pctNum,
      minOvr: minOvrNum,
      cards,
      cardsRefreshedAt: new Date().toISOString(),
      lastAlertedPrices: prior?.lastAlertedPrices || {},
      lastChecked: prior?.lastChecked || 0,
      lastError: null,
    };
    await saveWatches(env, watches);
    return jsonResponse({ ok: true, watch: watches[id] });
  }
```

- [ ] **Step 3: Verify**

From `worker/`:
```bash
npm run dev
```
```bash
curl -s -X POST http://localhost:8787/api/watches/program \
  -H "X-Auth: <your-AUTH_SECRET>" -H "Content-Type: application/json" \
  -d '{"slug":"golden-ticket","programName":"Golden Ticket","platform":"pc","pct":70,"minOvr":99}' \
  | head -c 800
```
Expected: `{"ok":true,"watch":{...}}` with `cards` containing 18 entries.

Inspect KV: `npx wrangler kv key get watches --binding=WATCHES --remote | head -c 1000` — the new watch is present (note: dev mode uses local KV; on `--remote` you see prod state).

Stop dev.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker): POST /api/watches/program creates program watches with synchronous member scrape"
```

---

## Task 7: Cron handler — partition by kind + program-watch tick logic

The every-minute cron runs both kinds. Extract player and program tick logic into separate functions to keep `pollOnce` readable.

**Files:**
- Modify: `worker/src/index.js`

- [ ] **Step 1: Add `fetchBulkMedians` helper**

Near the other fetchers:
```js
// Bulk fetch medians for many externalIds in one call. Returns Map<externalId, median|null>.
async function fetchBulkMedians(externalIds, platform) {
  if (externalIds.length === 0) return new Map();
  const csv = externalIds.join(',');
  const j = await fetchJson(`${MUTGG}/api/mutdb/prices/overall/playeritem/?external_ids=${csv}`);
  const out = new Map();
  for (const row of (j.data || [])) {
    out.set(Number(row.externalId ?? row.external_id), row.price?.[platform] ?? null);
  }
  return out;
}
```

> Note: confirm the response shape during implementation — the field may be `externalId` or `external_id`. Inspect one row's JSON during dev and pick the right key (the helper above tries both).

- [ ] **Step 2: Extract `pollPlayerWatch`**

Replace the per-watch loop inside `pollOnce` (the entire `for (const id of ids)` block, ~lines 137-182) with a partition + dispatch. First, add these helper functions ABOVE `pollOnce`:

```js
async function pollPlayerWatch(env, webhook, w, liveByKey) {
  const fetched = liveByKey.get(`${w.gameSlug}|${w.externalId}|${w.platform}`);
  if (fetched.error) {
    w.lastError = fetched.error;
    w.lastChecked = Date.now();
    return { id: w.id, name: w.name, error: w.lastError };
  }
  const { liveAuctions } = fetched;
  const matches = liveAuctions.filter(a =>
    a.buyNowPrice != null && (w.targetBin == null || a.buyNowPrice <= w.targetBin)
  );
  const cheapest = matches.reduce(
    (m, a) => (m == null || a.buyNowPrice < m.buyNowPrice) ? a : m,
    null
  );
  const beatsPrior = cheapest && (w.lastAlertedPrice == null || cheapest.buyNowPrice < w.lastAlertedPrice);

  let fired = 0;
  if (beatsPrior) {
    await postDiscord(webhook, {
      title: `🎯 ${w.name} (${w.program}) — ${PLATFORMS[w.platform] || w.platform}`,
      body: `**BIN ${fmt(cheapest.buyNowPrice)}** · target ${fmt(w.targetBin)}\nCurrent bid ${fmt(cheapest.currentBid ?? cheapest.startingBid)} · ends <t:${Math.floor(new Date(cheapest.endDate).getTime()/1000)}:R>${matches.length > 1 ? `\n*+${matches.length - 1} other listing(s) below target*` : ''}`,
      url: `${MUTGG}${w.url}#prices`,
      color: 0xF5C518,
      fields: [
        { name: 'Bids',   value: String(cheapest.bidCount ?? 0), inline: true },
        { name: 'Recur',  value: w.recurring ? 'Yes' : 'No', inline: true },
      ],
    });
    w.lastAlertedAt = Date.now();
    w.lastAlertedPrice = cheapest.buyNowPrice;
    fired = 1;
  }
  w.lastChecked = Date.now();
  w.lastError = null;
  return { id: w.id, name: w.name, matches: matches.length, cheapest: cheapest?.buyNowPrice ?? null, fired };
}

async function pollProgramWatch(env, webhook, w) {
  const externalIds = Object.keys(w.cards).map(Number);
  if (externalIds.length === 0) {
    w.lastError = 'no cards in watch';
    w.lastChecked = Date.now();
    return { id: w.id, programName: w.programName, error: w.lastError };
  }

  let medians;
  try {
    medians = await fetchBulkMedians(externalIds, w.platform);
  } catch (e) {
    w.lastError = `medians fetch failed: ${e.message}`;
    w.lastChecked = Date.now();
    return { id: w.id, programName: w.programName, error: w.lastError };
  }

  // Per-card live auctions in parallel.
  const results = await Promise.all(externalIds.map(async externalId => {
    try {
      const { liveAuctions } = await fetchLiveAuctions('26', externalId, w.platform);
      const cheapest = liveAuctions.reduce(
        (m, a) => a.buyNowPrice != null && (m == null || a.buyNowPrice < m.buyNowPrice) ? a : m,
        null
      );
      return { externalId, cheapest };
    } catch (e) {
      return { externalId, error: String(e.message || e) };
    }
  }));

  let fired = 0;
  const threshold = w.pct / 100;
  for (const { externalId, cheapest, error } of results) {
    if (error || !cheapest) continue;
    const median = medians.get(externalId);
    if (median == null) continue;
    const target = median * threshold;
    if (cheapest.buyNowPrice > target) continue;
    const prior = w.lastAlertedPrices[externalId];
    if (prior != null && cheapest.buyNowPrice >= prior) continue;

    const card = w.cards[externalId];
    const pctBelow = Math.round((1 - cheapest.buyNowPrice / median) * 100);
    await postDiscord(webhook, {
      title: `🎯 ${card.name} (${w.programName}) — ${PLATFORMS[w.platform] || w.platform}`,
      body: `**BIN ${fmt(cheapest.buyNowPrice)}** · median ${fmt(median)} · **${pctBelow}% under** (target ≤ ${w.pct}%)\nEnds <t:${Math.floor(new Date(cheapest.endDate).getTime()/1000)}:R>`,
      url: `${MUTGG}${card.url}#prices`,
      color: 0x3FA9F5,
      fields: [
        { name: 'OVR',  value: String(card.ovr),                inline: true },
        { name: 'Bids', value: String(cheapest.bidCount ?? 0),  inline: true },
      ],
    });
    w.lastAlertedPrices[externalId] = cheapest.buyNowPrice;
    fired++;
  }

  w.lastChecked = Date.now();
  w.lastError = null;
  return { id: w.id, programName: w.programName, cards: externalIds.length, fired };
}
```

- [ ] **Step 3: Rewrite `pollOnce` to partition**

Replace `pollOnce` with:
```js
async function pollOnce(env) {
  const webhook = env.DISCORD_WEBHOOK;
  if (!webhook) return { skipped: 'no DISCORD_WEBHOOK secret' };

  const watches = await loadWatches(env);
  const ids = Object.keys(watches);
  const playerIds  = ids.filter(id => watches[id].kind === 'player');
  const programIds = ids.filter(id => watches[id].kind === 'program');

  // Dedupe player fetches by (gameSlug, externalId, platform) — same as before.
  const keyOf = w => `${w.gameSlug}|${w.externalId}|${w.platform}`;
  const uniqueKeys = [...new Set(playerIds.map(id => keyOf(watches[id])))];
  const liveByKey = new Map();
  await Promise.all(uniqueKeys.map(async key => {
    const [gameSlug, externalId, platform] = key.split('|');
    try {
      const { liveAuctions } = await fetchLiveAuctions(gameSlug, externalId, platform);
      liveByKey.set(key, { liveAuctions });
    } catch (e) {
      liveByKey.set(key, { error: String(e.message || e) });
    }
  }));

  const playerResults  = [];
  for (const id of playerIds) playerResults.push(await pollPlayerWatch(env, webhook, watches[id], liveByKey));
  const programResults = [];
  for (const id of programIds) programResults.push(await pollProgramWatch(env, webhook, watches[id]));

  await saveWatches(env, watches);
  return {
    polled: ids.length,
    playerUniqueFetches: uniqueKeys.length,
    players:  playerResults,
    programs: programResults,
  };
}
```

- [ ] **Step 4: Trigger a poll against your dev-mode local watch**

From `worker/`:
```bash
npm run dev
```
```bash
curl -s -X POST http://localhost:8787/api/poll -H "X-Auth: <your-AUTH_SECRET>" | head -c 800
```
Expected: response includes both `players` and `programs` arrays. If you have the GT program watch from Task 6, `programs[0].fired` reflects any alerts fired.

Stop dev.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker): cron handles program watches alongside player watches"
```

---

## Task 8: Daily-refresh cron + manual trigger endpoint

**Files:**
- Modify: `worker/wrangler.toml`
- Modify: `worker/src/index.js`

- [ ] **Step 1: Add the daily cron to `wrangler.toml`**

Replace the `[triggers]` block with:
```toml
[triggers]
crons = [
  "* * * * *",      # every minute: poll watches
  "5 4 * * *",      # daily at 04:05 UTC: refresh program member lists
]
```

- [ ] **Step 2: Add `refreshProgramWatches` function**

In `worker/src/index.js`, add above `pollOnce`:
```js
// Re-scrape each program watch's member list from mut.gg. Run daily.
async function refreshProgramWatches(env) {
  const watches = await loadWatches(env);
  const programIds = Object.keys(watches).filter(id => watches[id].kind === 'program');
  const results = [];
  for (const id of programIds) {
    const w = watches[id];
    try {
      const html = await fetchProgramPage(w.slug);
      const parsed = parseProgramPage(html);
      const filtered = w.minOvr == null
        ? parsed
        : Object.fromEntries(Object.entries(parsed).filter(([, c]) => c.ovr >= w.minOvr));
      if (Object.keys(filtered).length === 0) {
        w.lastError = 'refresh: parser returned 0 matching cards (keeping stale list)';
      } else {
        w.cards = filtered;
        w.cardsRefreshedAt = new Date().toISOString();
        w.lastError = null;
      }
      results.push({ id, programName: w.programName, cards: Object.keys(w.cards).length });
    } catch (e) {
      w.lastError = `refresh failed: ${e.message}`;
      results.push({ id, programName: w.programName, error: w.lastError });
    }
  }
  await saveWatches(env, watches);
  return { refreshed: results.length, results };
}
```

- [ ] **Step 3: Branch on `event.cron` in `scheduled()`**

Find the default export at the bottom (~line 308). Replace `scheduled` with:
```js
  async scheduled(event, env, ctx) {
    if (event.cron === '5 4 * * *') {
      ctx.waitUntil(refreshProgramWatches(env));
    } else {
      ctx.waitUntil(pollOnce(env));
    }
  },
```

- [ ] **Step 4: Add `POST /api/refresh-programs` route**

Inside `handleApi`, after `/api/poll`, add:
```js
  // Manually trigger the daily refresh.
  if (req.method === 'POST' && path === '/api/refresh-programs') {
    const r = await refreshProgramWatches(env);
    return jsonResponse(r);
  }
```

- [ ] **Step 5: Verify the refresh path**

From `worker/`:
```bash
npm run dev
```
```bash
curl -s -X POST http://localhost:8787/api/refresh-programs -H "X-Auth: <your-AUTH_SECRET>"
```
Expected: `{"refreshed": N, "results": [...]}` where each entry has either `cards` count or an `error`. For the GT watch from Task 6: `cards` should still be 18.

Stop dev.

- [ ] **Step 6: Commit**

```bash
git add worker/wrangler.toml worker/src/index.js
git commit -m "feat(worker): daily program-member refresh cron"
```

---

## Task 9: UI — mode toggle + program form

**Files:**
- Modify: `worker/src/index.js` (the embedded `UI_HTML` template literal)

The existing add-watch card stays for player watches. Add a toggle at the top of the card and a separate program form revealed when "Program" is selected.

- [ ] **Step 1: Update the form card HTML**

Find the `<div class="card">` block holding the player-watch form (~line 377-414). Wrap it with a mode toggle and add a program-mode form. Replace the whole `<div class="card">...</div>` (the FIRST one, the add-watch card, NOT the alert log) with:

```html
<div class="card">
  <div class="row" style="gap:6px; margin-bottom:14px;">
    <button id="mode-player"  class="pill on"  type="button">Player</button>
    <button id="mode-program" class="pill off" type="button">Program</button>
  </div>

  <!-- PLAYER MODE FORM -->
  <div id="form-player">
    <div class="row" style="gap:12px;">
      <div class="grow">
        <label>Player</label>
        <input id="f-name" placeholder="Tyreek Hill" autocomplete="off">
      </div>
      <div style="flex:0 0 90px;">
        <label>OVR (optional)</label>
        <input id="f-ovr" type="number" inputmode="numeric" min="0" max="99" placeholder="any" autocomplete="off">
      </div>
      <div style="flex:1.3;">
        <label>Program</label>
        <select id="f-program"><option value="">— search a player first —</option></select>
      </div>
    </div>
    <div class="row" style="gap:12px; margin-top:10px;">
      <div style="flex:1;">
        <label>Platform</label>
        <select id="f-platform">
          <option value="pc">PC</option>
          <option value="xbox-series-x">Xbox Series X</option>
          <option value="playstation-5">PlayStation 5</option>
        </select>
      </div>
      <div style="flex:1;">
        <label>Target price (alert ≤)</label>
        <input id="f-target" type="number" placeholder="400000">
      </div>
      <div style="display:flex; flex-direction:column;">
        <label>Recurring</label>
        <button id="f-recurring" class="pill on" type="button">Yes</button>
      </div>
    </div>
    <div class="row" style="margin-top:12px; justify-content:flex-end;">
      <button id="btn-add" class="primary">Add watch</button>
    </div>
    <div id="add-status" class="status"></div>
  </div>

  <!-- PROGRAM MODE FORM -->
  <div id="form-program" style="display:none;">
    <div class="row" style="gap:12px;">
      <div class="grow">
        <label>Program</label>
        <select id="pf-slug"><option value="">— loading programs… —</option></select>
      </div>
      <div style="flex:0 0 110px;">
        <label>Min OVR (optional)</label>
        <input id="pf-minovr" type="number" inputmode="numeric" min="0" max="99" placeholder="any">
      </div>
    </div>
    <div class="row" style="gap:12px; margin-top:10px;">
      <div style="flex:1;">
        <label>Platform</label>
        <select id="pf-platform">
          <option value="pc">PC</option>
          <option value="xbox-series-x">Xbox Series X</option>
          <option value="playstation-5">PlayStation 5</option>
        </select>
      </div>
      <div style="flex:0 0 140px;">
        <label>Target % of median</label>
        <input id="pf-pct" type="number" min="50" max="95" value="70">
      </div>
    </div>
    <div class="row" style="margin-top:12px; justify-content:flex-end;">
      <button id="btn-add-program" class="primary">Add program watch</button>
    </div>
    <div id="add-program-status" class="status"></div>
  </div>
</div>
```

- [ ] **Step 2: Add the mode toggle + program-form JS**

In the `<script>` block (~line 426), AFTER the existing `$('#f-recurring').onclick = ...` block, add:

```js
let programsCache = null;
async function loadPrograms() {
  if (programsCache) return programsCache;
  const sel = $('#pf-slug');
  sel.innerHTML = '<option value="">— loading programs… —</option>';
  try {
    const { programs } = await api('/api/programs');
    programsCache = programs.sort((a, b) => b.count - a.count);   // most-populated first
    sel.innerHTML = '<option value="">— pick a program —</option>'
      + programsCache.map(p => '<option value="' + p.slug + '" data-name="' + p.name.replace(/"/g, '&quot;') + '">' + p.name + ' (' + p.count + ' cards)</option>').join('');
  } catch (e) {
    sel.innerHTML = '<option value="">— error: ' + e.message + ' —</option>';
  }
  return programsCache;
}

function setMode(mode) {
  $('#mode-player').classList.toggle('on', mode === 'player');
  $('#mode-player').classList.toggle('off', mode !== 'player');
  $('#mode-program').classList.toggle('on', mode === 'program');
  $('#mode-program').classList.toggle('off', mode !== 'program');
  $('#form-player').style.display  = mode === 'player'  ? '' : 'none';
  $('#form-program').style.display = mode === 'program' ? '' : 'none';
  if (mode === 'program') loadPrograms();
}
$('#mode-player').onclick  = () => setMode('player');
$('#mode-program').onclick = () => setMode('program');

$('#btn-add-program').onclick = async () => {
  const slug = $('#pf-slug').value;
  const programName = $('#pf-slug').selectedOptions[0]?.dataset.name || slug;
  const pct  = parseInt($('#pf-pct').value || '70', 10);
  const minOvrRaw = ($('#pf-minovr').value || '').trim();
  const minOvr = minOvrRaw === '' ? null : parseInt(minOvrRaw, 10);
  const platform = $('#pf-platform').value;
  const status = $('#add-program-status'); status.className = 'status'; status.textContent = '';
  if (!slug) { status.className = 'status err'; status.textContent = 'Pick a program.'; return; }
  status.innerHTML = '<span class="spinner"></span> Fetching members + adding…';
  try {
    const r = await api('/api/watches/program', { method: 'POST', body: JSON.stringify({ slug, programName, platform, pct, minOvr }) });
    if (r.error) throw new Error(r.error);
    const count = r.watch ? Object.keys(r.watch.cards).length : 0;
    status.className = 'status ok'; status.textContent = 'Added — watching ' + count + ' cards.';
    $('#pf-slug').value = ''; $('#pf-minovr').value = ''; $('#pf-pct').value = '70';
    refresh();
  } catch (e) { status.className = 'status err'; status.textContent = 'Failed: ' + e.message; }
};
```

- [ ] **Step 3: Verify in browser**

From `worker/`:
```bash
npm run dev
```
Open http://localhost:8787. Enter your AUTH_SECRET when prompted. Click **Program** — the form should swap, the program dropdown should populate with options including "Golden Ticket (18 cards)". Pick it, set pct=95, click **Add program watch**. Confirm a success message appears.

Stop dev.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker/ui): add program-watch mode toggle and form"
```

---

## Task 10: UI — render program watches in the alert log

**Files:**
- Modify: `worker/src/index.js` (the `refresh()` function in UI_HTML)

Today's `refresh()` renders one card type. Add branching: when `w.kind === 'program'`, render a different layout.

- [ ] **Step 1: Replace the body of `refresh()`'s per-watch loop**

Find `async function refresh()` (~line 535). Inside the `for (const id of ids)` loop, replace the entire `const card = document.createElement('div'); ... log.appendChild(card); ... snapshot(w).then(...)` block with:

```js
    const w = watches[id];
    const card = document.createElement('div'); card.className = 'alert';

    if (w.kind === 'program') {
      const cardCount = Object.keys(w.cards || {}).length;
      const alertedIds = Object.keys(w.lastAlertedPrices || {});
      card.innerHTML = \`
        <div class="ovr">P</div>
        <div>
          <div><span class="meta-name">\${w.programName?.toUpperCase()}</span></div>
          <div class="sub">≤ \${w.pct}% of median · \${cardCount} cards\${w.minOvr ? ' · ' + w.minOvr + '+ OVR' : ''} · \${PLATFORMS[w.platform] || w.platform}</div>
          <div class="sub" style="margin-top:6px;">Members refreshed \${w.cardsRefreshedAt ? new Date(w.cardsRefreshedAt).toLocaleString() : 'never'}</div>
          \${alertedIds.length ? '<details style="margin-top:8px;"><summary class="sub" style="cursor:pointer;">Alerted cards (' + alertedIds.length + ')</summary><div style="margin-top:6px;">' + alertedIds.map(eid => '<div class="sub" style="text-transform:none; margin-top:2px;">' + (w.cards[eid]?.name || eid) + ' — last @ ' + fmt(w.lastAlertedPrices[eid]) + '</div>').join('') + '</div></details>' : ''}
          \${w.lastError ? '<div class="status err">⚠️ ' + w.lastError + '</div>' : ''}
        </div>
        <div class="actions">
          <button class="iconbtn edit" title="Refresh members" data-action="refresh">↻</button>
          <button class="iconbtn del"  title="Remove"          data-action="del">✕</button>
        </div>
      \`;
      card.querySelector('[data-action=del]').onclick = async () => {
        if (!confirm('Remove program watch for ' + w.programName + '?')) return;
        await api('/api/watches/' + encodeURIComponent(w.id), { method: 'DELETE' });
        refresh();
      };
      card.querySelector('[data-action=refresh]').onclick = async () => {
        const r = await api('/api/refresh-programs', { method: 'POST' });
        const me = (r.results || []).find(x => x.id === w.id);
        alert(me?.error ? 'Refresh error: ' + me.error : 'Refreshed: ' + (me?.cards ?? 0) + ' cards.');
        refresh();
      };
      log.appendChild(card);
      continue;
    }

    // PLAYER WATCH — existing rendering, unchanged
    card.innerHTML = \`
      <div class="ovr">\${w.ovr ?? '?'}</div>
      <div>
        <div><span class="meta-name">\${w.name?.toUpperCase()}</span></div>
        <div class="sub">\${w.program} · \${PLATFORMS[w.platform] || w.platform}</div>
        <div class="prices">
          <div class="price bin"><div class="v" data-k="bin">…</div><div class="l">BIN</div></div>
          <div class="price med"><div class="v" data-k="med">…</div><div class="l">MED</div></div>
          <div class="price target"><div class="v">\${fmt(w.targetBin)}</div><div class="l">TARGET</div></div>
        </div>
        <div style="margin-top:8px;">
          <button class="pill \${w.recurring?'on':'off'}" data-action="rec">\${w.recurring?'RECURRING':'ONE-SHOT'}</button>
          \${w.lastAlertedAt ? '<span class="alerted-at">Alerted at ' + new Date(w.lastAlertedAt).toLocaleString() + ' · ' + fmt(w.lastAlertedPrice) + '</span>' : ''}
        </div>
        \${w.lastError ? '<div class="status err">⚠️ ' + w.lastError + '</div>' : ''}
      </div>
      <div class="actions">
        <button class="iconbtn del" title="Remove" data-action="del">✕</button>
      </div>
    \`;
    card.querySelector('[data-action=rec]').onclick = async () => {
      await api('/api/watches', { method: 'POST', body: JSON.stringify({ ...w, recurring: !w.recurring }) });
      refresh();
    };
    card.querySelector('[data-action=del]').onclick = async () => {
      if (!confirm('Remove watch for ' + w.name + ' (' + w.program + ')?')) return;
      await api('/api/watches/' + encodeURIComponent(w.id), { method: 'DELETE' });
      refresh();
    };
    log.appendChild(card);
    snapshot(w).then(s => {
      card.querySelector('[data-k=bin]').textContent = fmt(s.cheapestBin);
      card.querySelector('[data-k=med]').textContent = fmt(s.med);
    });
```

- [ ] **Step 2: Verify in browser**

```bash
npm run dev
```
Open http://localhost:8787. Confirm:
- Existing player watches still render with BIN/MED/TARGET
- The GT program watch from Task 6 renders with "P" badge, "≤95% of median · 18 cards · 99+ OVR · PC", refresh + delete buttons
- Clicking the refresh button shows a success alert

Stop dev.

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "feat(worker/ui): render program watches in alert log with per-card alert history"
```

---

## Task 11: Deploy + live verification

- [ ] **Step 1: Run all tests**

From `worker/`:
```bash
npm test
```
Expected: all green.

- [ ] **Step 2: Deploy**

```bash
npm run deploy
```
Expected output ends with `schedule: * * * * *` AND `schedule: 5 4 * * *`. Note the Version ID for rollback if needed.

- [ ] **Step 3: Tail production**

In one shell:
```bash
npm run tail
```

In another shell, hit prod UI: open https://mutgg-alerts.mrosale2.workers.dev/, click **Program**, pick **Golden Ticket**, platform PC, pct **95** (deliberately generous so something fires), minOvr **99**, click **Add program watch**. Expected: success message.

Watch tail output for the next minute. Within 60s you should see:
- A cron tick: `"* * * * *" @ <time> - Ok`
- Likely one or more Discord alerts firing for cards on existing GT listings

- [ ] **Step 4: Verify Discord received the alerts**

Check your Discord channel. Each alert should show:
- 🎯 `<player name>` (Golden Ticket) — PC
- BIN, median, percent under, target
- OVR field, Bids field
- Clickable URL to the mut.gg player page

- [ ] **Step 5: Verify the daily refresh works manually**

```bash
curl -s -X POST https://mutgg-alerts.mrosale2.workers.dev/api/refresh-programs \
  -H "X-Auth: <your-AUTH_SECRET>"
```
Expected: `{"refreshed": 1, "results": [{"id":"program-golden-ticket-pc","programName":"Golden Ticket","cards":18}]}`.

- [ ] **Step 6: Stop the tail, push commits**

Ctrl+C the tail. Then:
```bash
git push origin main
```

- [ ] **Step 7: Tune the pct on your real watch**

The pct=95 from Step 3 was a test value. Once verified, edit the watch (remove it via the UI, re-add with your real target, e.g., pct=70) or update via curl:
```bash
curl -s -X POST https://mutgg-alerts.mrosale2.workers.dev/api/watches/program \
  -H "X-Auth: <your-AUTH_SECRET>" -H "Content-Type: application/json" \
  -d '{"slug":"golden-ticket","programName":"Golden Ticket","platform":"pc","pct":70,"minOvr":99}'
```

---

## Notes

- **`recurring`-flag bug** is intentionally not touched here (separate issue: the flag is stored and displayed but never read by the alert rule).
- **Pagination for large programs** (Flashbacks ~322 cards) is not handled. Adding a Flashbacks watch may give a partial member list. The UI shows the count so you can spot this.
- **Subrequest budget** for a GT program watch per tick: 1 medians + 18 live-auction + ≤18 alerts = ≤37 subrequests. Well under the 1,000 paid-plan cap. You can run 10+ similarly-sized program watches concurrently.
