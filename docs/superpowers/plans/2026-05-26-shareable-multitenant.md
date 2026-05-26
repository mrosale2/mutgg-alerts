# Shareable Multi-Tenant Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the single-tenant Cloudflare Worker so each friend has their own URL-keyed watch list + own Discord webhook, AND fix the cron-killing 403s from mut.gg's adaptive Cloudflare bot-shield.

**Architecture:** Single-file Worker (`worker/src/index.js`) keeps its convention. KV gains two key namespaces (`user:<slug>`, `index:slug:<slug>`) replacing the single `watches` blob. Routing splits into `/`, `/u/<slug>`, `/api/u/<slug>/*`, `/admin*`, `/api/new-user`, `/api/admin/migrate`. `fetchJson` gains retry-with-backoff. Median fetch leaves the cron path entirely.

**Tech Stack:** Cloudflare Workers (vanilla JS, ES modules), Cloudflare KV, esbuild via wrangler, embedded HTML UI string. No npm test framework — verification is `wrangler dev` + curl + browser.

**Testing note:** The repo has no automated test suite. Each task ends in a **manual verification** step using `wrangler dev` (local) or `npm run deploy` + curl/browser (live). This is honest about the project's actual quality bar — adding a test framework is out of scope.

**Deploy checkpoints:** Tasks 1-3 ship the cron reliability fix in isolation (deployable + valuable on its own). Tasks 4-11 are the multi-tenant refactor and must ship together because routing changes are intertwined. Task 12 is the live migration.

**Files:**
- Modify: `worker/src/index.js` (every task touches this single file; line numbers below refer to its state at the *start* of each task, which shifts as tasks land)
- Create: nothing
- Spec reference: `docs/superpowers/specs/2026-05-26-shareable-multitenant-design.md`

---

## Task 1: Push existing 5 unpushed commits

Establish a clean baseline before starting refactor. Per `git status`, the local branch is 5 commits ahead of `origin/main`.

**Files:** none modified

- [ ] **Step 1: Confirm what will be pushed**

Run:
```bash
cd /c/Users/mcros/mutgg-alerts
git log origin/main..HEAD --oneline
```

Expected: 5 commits, ending in `f5eb8a7 docs: add SESSION_LOG with 2026-05-17 entry`.

- [ ] **Step 2: Push**

Run:
```bash
git push origin main
```

Expected: `5 commits pushed` or similar success message.

- [ ] **Step 3: Verify**

Run:
```bash
git log origin/main..HEAD --oneline
```

Expected: empty output (local in sync with remote).

---

## Task 2: Add retry-with-backoff to `fetchJson`

Root cause of broken cron: mut.gg's adaptive bot-shield returns 403 on a fresh datacenter IP's first hit, then 200 on retry. Add 3-try retry with 0/2s/5s backoff on 403/429/5xx.

**Files:**
- Modify: `worker/src/index.js:43-55` (the `fetchJson` function)

- [ ] **Step 1: Replace `fetchJson` with retry version**

Open `worker/src/index.js`. Locate the existing `fetchJson` (around line 43-55) and replace it with:

```javascript
async function fetchJson(url, init = {}) {
  const RETRY_DELAYS_MS = [0, 2000, 5000];  // 3 attempts total
  const RETRY_STATUSES  = new Set([403, 429, 500, 502, 503, 504]);
  let lastErr;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise(res => setTimeout(res, RETRY_DELAYS_MS[attempt]));
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: { ...BROWSER_HEADERS, ...(init.headers || {}) },
      });
      if (r.ok) return await r.json();
      if (!RETRY_STATUSES.has(r.status)) {
        throw new Error(`${url}: HTTP ${r.status}`);
      }
      lastErr = new Error(`${url}: HTTP ${r.status} (attempt ${attempt + 1})`);
      console.log(`fetchJson retry: ${lastErr.message}`);
    } catch (e) {
      lastErr = e;
      if (attempt === RETRY_DELAYS_MS.length - 1) break;
      console.log(`fetchJson error attempt ${attempt + 1}: ${e.message}`);
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}
```

- [ ] **Step 2: Local verification with wrangler dev**

Run in a separate terminal:
```bash
cd /c/Users/mcros/mutgg-alerts/worker
npx wrangler dev --local
```

In another terminal:
```bash
curl -s "http://localhost:8787/api/snapshot?externalId=119117838&platform=pc&gameSlug=26&auth=$(cat /c/Users/mcros/mutgg-alerts/.auth-secret-NEW-DELETE-AFTER-SAVING.txt)" | head -c 300
```

Expected: JSON with `cheapestBin` and `liveCount` fields (no `error`). Watch the wrangler dev output for `fetchJson retry:` lines — they confirm retry fires when mut.gg 403s.

Stop wrangler dev with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
cd /c/Users/mcros/mutgg-alerts
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
fix(worker): retry mut.gg 403/429/5xx with backoff

mut.gg's Cloudflare bot-shield 403s the first hit from a fresh
datacenter IP, then 200s on retry. 3 attempts at 0/2s/5s delays.
Logs retry attempts to wrangler tail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Drop median fetch from cron path

`/api/mutdb/prices/overall/playeritem/` returns 403 uniformly (no retry recovers it). It's currently called only from the UI snapshot path (line 262), not from `pollOnce` — so this task verifies that's true and tightens the snapshot endpoint to swallow the failure cleanly.

**Files:**
- Modify: `worker/src/index.js:254-270` (the `/api/snapshot` route)

- [ ] **Step 1: Verify median is not called from `pollOnce`**

Run:
```bash
grep -n fetchOverallPrices /c/Users/mcros/mutgg-alerts/worker/src/index.js
```

Expected: exactly two hits — the definition (~line 73) and the `/api/snapshot` call (~line 262). If `pollOnce` also calls it, STOP and report — the spec assumed it didn't.

- [ ] **Step 2: Tighten snapshot to never let median fail the whole request**

Locate the `/api/snapshot` handler (around line 254-270). Replace the `try` block with:

```javascript
    try {
      const live = await fetchLiveAuctions(gameSlug, externalId, platform).catch(e => {
        return { liveAuctions: [], lastUpdate: null, _error: String(e.message || e) };
      });
      const overall = await fetchOverallPrices(externalId).catch(() => null);
      const cheapestBin = live.liveAuctions.reduce(
        (m, a) => a.buyNowPrice != null && (m == null || a.buyNowPrice < m) ? a.buyNowPrice : m,
        null
      );
      const med = overall?.price?.[platform] ?? null;
      return jsonResponse({
        cheapestBin, med,
        liveCount: live.liveAuctions.length,
        lastUpdate: live.lastUpdate,
        ...(live._error ? { error: live._error } : {}),
      });
    } catch (e) {
      return jsonResponse({ error: String(e.message || e) }, { status: 502 });
    }
```

- [ ] **Step 3: Local verification**

Run `npx wrangler dev --local` (from `worker/`).

Test snapshot for a card that exists:
```bash
curl -s "http://localhost:8787/api/snapshot?externalId=119117838&platform=pc&gameSlug=26&auth=<your-secret>" | head -c 300
```

Expected: JSON with `cheapestBin` populated. `med` may be `null` (median 403'd) but the response is still 200.

Stop wrangler dev.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
fix(worker): make snapshot resilient to median endpoint 403

mut.gg's /prices/overall/playeritem/ is now consistently 403'd.
Snapshot now returns cheapestBin + null med rather than failing
the whole request. Cron path already doesn't call this endpoint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3.5: Optional early deploy (reliability fix in isolation)

The cron reliability fix is complete and deployable on its own. Multi-tenant work can ship later in a follow-up deploy. If you want the cron alerting again ASAP before doing the multi-tenant refactor, do this task. Otherwise skip to Task 4.

**Files:** none modified

- [ ] **Step 1: Deploy**

```bash
cd /c/Users/mcros/mutgg-alerts/worker
npm run deploy
```

Expected: `Published mutgg-alerts (X.XXs)` with the workers.dev URL.

- [ ] **Step 2: Watch live cron**

```bash
npx wrangler tail
```

Wait ~2 min for two cron ticks. Expected: `fetchJson retry:` lines on some ticks (mut.gg 403 → retry recovers), `polled N watches` final result lines. No tick should fail completely.

- [ ] **Step 3: Push commits to origin**

```bash
cd /c/Users/mcros/mutgg-alerts
git push origin main
```

---

## Task 4: Add per-user KV helpers

Replace the single-key `loadWatches` / `saveWatches` (lines 81-87) with a per-user data layer keyed by random slug.

**Files:**
- Modify: `worker/src/index.js:81-87` (the `// ---------- KV ----------` block)

- [ ] **Step 1: Replace the KV section**

Locate the `// ---------- KV ----------` block. Replace lines 79-87 with:

```javascript
// ---------- KV ----------
//
// Two key namespaces in the WATCHES binding:
//   user:<slug>       → JSON { discordWebhook, watches: { [id]: Watch }, createdAt, lastSeenAt }
//   index:slug:<slug> → "1"   (marker; iterated by cron via list({ prefix: "index:slug:" }))
//
// Legacy single-key blob "watches" is migrated by POST /api/admin/migrate then deleted.

const SLUG_BYTES = 12;  // 12 random bytes → 16 base64url chars → ~96 bits entropy

function newSlug() {
  const buf = new Uint8Array(SLUG_BYTES);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const userKey  = slug => `user:${slug}`;
const indexKey = slug => `index:slug:${slug}`;

async function loadUser(env, slug) {
  const raw = await env.WATCHES.get(userKey(slug));
  return raw ? JSON.parse(raw) : null;
}

async function saveUser(env, slug, user) {
  user.lastSeenAt = Date.now();
  await env.WATCHES.put(userKey(slug), JSON.stringify(user));
}

async function createUser(env, slug, init = {}) {
  const user = {
    discordWebhook: init.discordWebhook || '',
    watches: init.watches || {},
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  await env.WATCHES.put(userKey(slug), JSON.stringify(user));
  await env.WATCHES.put(indexKey(slug), '1');
  return user;
}

async function deleteUser(env, slug) {
  await env.WATCHES.delete(userKey(slug));
  await env.WATCHES.delete(indexKey(slug));
}

async function listUsers(env) {
  const out = [];
  let cursor;
  do {
    const list = await env.WATCHES.list({ prefix: 'index:slug:', cursor });
    for (const k of list.keys) out.push(k.name.slice('index:slug:'.length));
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return out;
}
```

- [ ] **Step 2: Local verification (KV helpers in isolation)**

Run `npx wrangler dev --local` (from `worker/`).

In another terminal:
```bash
# Create a test user via wrangler kv
npx wrangler kv key put --binding=WATCHES --local "user:testslug" '{"discordWebhook":"","watches":{},"createdAt":0,"lastSeenAt":0}'
npx wrangler kv key put --binding=WATCHES --local "index:slug:testslug" "1"
npx wrangler kv key list --binding=WATCHES --local
```

Expected: both keys appear.

Cleanup:
```bash
npx wrangler kv key delete --binding=WATCHES --local "user:testslug"
npx wrangler kv key delete --binding=WATCHES --local "index:slug:testslug"
```

Stop wrangler dev.

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
feat(worker): add per-user KV helpers (slug + index namespaces)

Introduces user:<slug> and index:slug:<slug> key layout alongside
the existing single-key "watches" blob. Old data layer untouched
by this commit; cron and HTTP routes still read the legacy key.
Migration happens in a later commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rewrite `pollOnce` → `pollAll` (per-user iteration + cross-user dedup)

Cron now iterates all users via the `index:slug:*` markers, dedupes mut.gg fetches across the whole set, and dispatches alerts to each user's own webhook (with env fallback).

**Files:**
- Modify: `worker/src/index.js:113-186` (the `pollOnce` function and the `scheduled` entrypoint that calls it)

- [ ] **Step 1: Replace `pollOnce` with `pollAll`**

Locate the `// ---------- cron: poll & alert ----------` block. Replace `pollOnce` (lines ~113-186) with:

```javascript
async function pollAll(env) {
  const slugs = await listUsers(env);
  if (slugs.length === 0) return { skipped: 'no users' };

  const users = [];
  for (const slug of slugs) {
    const u = await loadUser(env, slug);
    if (u) users.push({ slug, user: u });
  }

  // Cross-user dedup: one mut.gg fetch per unique (gameSlug, externalId, platform)
  const keyOf = w => `${w.gameSlug || '26'}|${w.externalId}|${w.platform}`;
  const uniqueKeys = new Set();
  for (const { user } of users) {
    for (const w of Object.values(user.watches)) uniqueKeys.add(keyOf(w));
  }

  const liveByKey = new Map();
  await Promise.all([...uniqueKeys].map(async key => {
    const [gameSlug, externalId, platform] = key.split('|');
    try {
      const { liveAuctions } = await fetchLiveAuctions(gameSlug, externalId, platform);
      liveByKey.set(key, { liveAuctions });
    } catch (e) {
      liveByKey.set(key, { error: String(e.message || e) });
    }
  }));

  const summary = { users: 0, polled: 0, uniqueFetches: uniqueKeys.size, fired: 0 };

  for (const { slug, user } of users) {
    const webhook = user.discordWebhook || env.DISCORD_WEBHOOK;
    summary.users += 1;
    const ids = Object.keys(user.watches);
    if (ids.length === 0) continue;

    let userDirty = false;
    for (const id of ids) {
      const w = user.watches[id];
      const fetched = liveByKey.get(keyOf(w));
      summary.polled += 1;

      if (fetched.error) {
        w.lastError   = fetched.error;
        w.lastChecked = Date.now();
        userDirty = true;
        continue;
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

      if (beatsPrior && webhook) {
        await postDiscord(webhook, {
          title: `🎯 ${w.name} (${w.program}) — ${PLATFORMS[w.platform] || w.platform}`,
          body: `**BIN ${fmt(cheapest.buyNowPrice)}** · target ${fmt(w.targetBin)}\nCurrent bid ${fmt(cheapest.currentBid ?? cheapest.startingBid)} · ends <t:${Math.floor(new Date(cheapest.endDate).getTime()/1000)}:R>${matches.length > 1 ? `\n*+${matches.length - 1} other listing(s) below target*` : ''}`,
          url: `${MUTGG}${w.url}#prices`,
          color: 0xF5C518,
          fields: [
            { name: 'Bids',  value: String(cheapest.bidCount ?? 0), inline: true },
            { name: 'Recur', value: w.recurring ? 'Yes' : 'No',     inline: true },
          ],
        });
        w.lastAlertedAt    = Date.now();
        w.lastAlertedPrice = cheapest.buyNowPrice;
        summary.fired += 1;
      }

      w.lastChecked = Date.now();
      w.lastError   = null;
      userDirty = true;
    }

    if (userDirty) await saveUser(env, slug, user);
  }

  return summary;
}
```

- [ ] **Step 2: Update the `scheduled` entrypoint**

Locate the `export default` block (around line 308). Change `pollOnce(env)` to `pollAll(env)`:

```javascript
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAll(env));
  },
  async fetch(req, env) {
    // (unchanged for now; rewritten in Task 7)
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, url);
    return new Response(UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
};
```

- [ ] **Step 3: Remove the now-unused `loadWatches` / `saveWatches`**

They're still referenced by the legacy `handleApi` until Task 7 rewrites it. **Leave them in place for now** — Task 7 will delete them along with the legacy routes.

- [ ] **Step 4: Local verification**

Seed a test user and trigger poll:

```bash
cd /c/Users/mcros/mutgg-alerts/worker
npx wrangler dev --local

# In another terminal — seed a test user with one cheap watch
npx wrangler kv key put --binding=WATCHES --local "index:slug:testslug" "1"
npx wrangler kv key put --binding=WATCHES --local "user:testslug" '{"discordWebhook":"","watches":{"119117838-pc":{"id":"119117838-pc","externalId":119117838,"gameSlug":"26","url":"/players/tyreek-hill/","name":"Tyreek Hill","program":"Test","ovr":99,"platform":"pc","targetBin":1,"recurring":false,"lastChecked":0,"lastError":null,"lastAlertedAt":null,"lastAlertedPrice":null}},"createdAt":0,"lastSeenAt":0}'

# Trigger scheduled() manually
curl -X POST "http://localhost:8787/__scheduled"
```

Expected (in wrangler dev terminal): logs showing `pollAll` iterating, one unique fetch, and either a successful poll or `fetchJson retry:` lines. Target of 1 coin won't fire an alert, which is correct (no listing that cheap).

Cleanup:
```bash
npx wrangler kv key delete --binding=WATCHES --local "index:slug:testslug"
npx wrangler kv key delete --binding=WATCHES --local "user:testslug"
```

Stop wrangler dev.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
feat(worker): cron iterates per-user with cross-user fetch dedup

pollAll() replaces pollOnce(). Iterates users via index:slug:*,
collects unique (gameSlug,externalId,platform) keys across ALL
users, fetches each one once, fans results out to each user's
alert logic. Per-user webhook with env fallback.

Legacy /api/* routes still read the old "watches" key — rewritten
in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add migration endpoint

One-shot `POST /api/admin/migrate?key=<AUTH_SECRET>` reads the legacy single-key `watches` blob, creates `user:matt-<slug>` with all of them, deletes the legacy key. Idempotent (no-op if legacy key absent).

**Files:**
- Modify: `worker/src/index.js` (add a route inside `handleApi`, before the final `return jsonResponse({ error: 'not found' }`)

- [ ] **Step 1: Add the migration route**

In `handleApi` (around the `/api/cleanup-seen` route, line ~291), add this route **before** the final 404 fallback:

```javascript
  // One-shot migration: legacy single-key "watches" → user:<slug> + index:slug:<slug>
  // Idempotent: no-op if legacy key absent or already migrated.
  if (req.method === 'POST' && path === '/api/admin/migrate') {
    const legacyRaw = await env.WATCHES.get('watches');
    if (!legacyRaw) return jsonResponse({ ok: true, skipped: 'no legacy watches key' });
    const legacyWatches = JSON.parse(legacyRaw);
    const slug = 'matt-' + newSlug();
    await createUser(env, slug, {
      discordWebhook: '',   // empty → falls back to env.DISCORD_WEBHOOK in cron
      watches: legacyWatches,
    });
    await env.WATCHES.delete('watches');
    return jsonResponse({ ok: true, slug, migratedWatches: Object.keys(legacyWatches).length });
  }
```

- [ ] **Step 2: Local verification**

Seed a legacy blob and migrate:

```bash
cd /c/Users/mcros/mutgg-alerts/worker
npx wrangler dev --local

npx wrangler kv key put --binding=WATCHES --local "watches" '{"119117838-pc":{"id":"119117838-pc","externalId":119117838,"gameSlug":"26","platform":"pc","name":"Test","program":"Test","targetBin":1000000}}'

# AUTH_SECRET must be set in .dev.vars for local dev
echo 'AUTH_SECRET = "testsecret"' > .dev.vars

# Restart wrangler dev (Ctrl+C, rerun) to pick up .dev.vars

curl -X POST "http://localhost:8787/api/admin/migrate?auth=testsecret"
```

Expected: `{"ok":true,"slug":"matt-XXXXXXXXXXXXXXXX","migratedWatches":1}`

Verify:
```bash
npx wrangler kv key list --binding=WATCHES --local
npx wrangler kv key get --binding=WATCHES --local "watches" 2>&1 | head -1
```

Expected: `user:matt-...` and `index:slug:matt-...` present, legacy `watches` key returns "not found".

Re-run the migrate POST:
```bash
curl -X POST "http://localhost:8787/api/admin/migrate?auth=testsecret"
```

Expected: `{"ok":true,"skipped":"no legacy watches key"}` (idempotent).

Cleanup:
```bash
npx wrangler kv key list --binding=WATCHES --local --prefix=user: | grep '"name"' | sed 's/.*"name": "\(.*\)".*/\1/' | xargs -I{} npx wrangler kv key delete --binding=WATCHES --local "{}"
npx wrangler kv key list --binding=WATCHES --local --prefix=index: | grep '"name"' | sed 's/.*"name": "\(.*\)".*/\1/' | xargs -I{} npx wrangler kv key delete --binding=WATCHES --local "{}"
rm .dev.vars
```

Stop wrangler dev.

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
feat(worker): add idempotent migration endpoint

POST /api/admin/migrate (admin-key gated) imports the legacy
single-key "watches" blob into user:matt-<slug> + index marker,
then deletes the legacy key. Safe to re-run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Refactor `/api/*` routes to `/api/u/<slug>/*` (slug-as-auth)

Replace `handleApi`'s `AUTH_SECRET`-gated single-tenant routes with `/api/u/<slug>/*` routes where the slug itself is the auth token. Delete the now-orphan `loadWatches`/`saveWatches` and the old single-tenant routes.

**Files:**
- Modify: `worker/src/index.js` (delete lines 81-87 `loadWatches`/`saveWatches`; replace `handleApi`; update `fetch` entrypoint to route based on path shape)

- [ ] **Step 1: Delete `loadWatches` and `saveWatches`**

They live around line 81-87 (`async function loadWatches`, `async function saveWatches`). Remove both functions entirely. The comment block above them was already replaced in Task 4.

- [ ] **Step 2: Replace `handleApi` with `handleUserApi` + admin router**

Find the existing `handleApi` (starts around line 204 with the `// ---------- HTTP API ----------` comment). Replace the entire function and its `checkAuth` / `unauthorized` helpers with:

```javascript
// ---------- HTTP API ----------

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function notFound() { return jsonResponse({ error: 'not found' }, { status: 404 }); }
function badRequest(msg) { return jsonResponse({ error: msg }, { status: 400 }); }
function adminUnauthorized() { return jsonResponse({ error: 'unauthorized' }, { status: 401 }); }

function adminOk(req, env, url) {
  const provided = req.headers.get('X-Auth') || url.searchParams.get('key') || url.searchParams.get('auth');
  return env.AUTH_SECRET && provided === env.AUTH_SECRET;
}

// /api/u/<slug>/<rest>
async function handleUserApi(req, env, url, slug, rest) {
  const user = await loadUser(env, slug);
  if (!user) return notFound();

  // GET /api/u/<slug>/watches
  if (req.method === 'GET' && rest === 'watches') {
    return jsonResponse({ watches: user.watches, discordWebhook: user.discordWebhook });
  }

  // POST /api/u/<slug>/watches
  if (req.method === 'POST' && rest === 'watches') {
    const body = await req.json();
    const { externalId, gameSlug, url: playerUrl, name, program, ovr, platform, targetBin, recurring } = body;
    if (!externalId || !platform) return badRequest('missing externalId or platform');
    const id = `${externalId}-${platform}`;
    user.watches[id] = {
      id, externalId, gameSlug: gameSlug || '26', url: playerUrl, name, program, ovr,
      platform,
      targetBin: targetBin == null ? null : Number(targetBin),
      recurring: !!recurring,
      lastChecked:      user.watches[id]?.lastChecked      || 0,
      lastError:        null,
      lastAlertedAt:    user.watches[id]?.lastAlertedAt    || null,
      lastAlertedPrice: user.watches[id]?.lastAlertedPrice || null,
    };
    await saveUser(env, slug, user);
    return jsonResponse({ ok: true, watch: user.watches[id] });
  }

  // DELETE /api/u/<slug>/watches/<id>
  if (req.method === 'DELETE' && rest.startsWith('watches/')) {
    const id = decodeURIComponent(rest.slice('watches/'.length));
    delete user.watches[id];
    await saveUser(env, slug, user);
    return jsonResponse({ ok: true });
  }

  // PUT /api/u/<slug>/settings  body: { discordWebhook }
  if (req.method === 'PUT' && rest === 'settings') {
    const body = await req.json();
    if (typeof body.discordWebhook === 'string') user.discordWebhook = body.discordWebhook.trim();
    await saveUser(env, slug, user);
    return jsonResponse({ ok: true, discordWebhook: user.discordWebhook });
  }

  // GET /api/u/<slug>/search?name=...
  if (req.method === 'GET' && rest === 'search') {
    const name = url.searchParams.get('name') || '';
    if (!name) return jsonResponse({ data: [] });
    const data = await searchPlayer(name);
    return jsonResponse({ data });
  }

  // GET /api/u/<slug>/snapshot?externalId=...&platform=...&gameSlug=...
  if (req.method === 'GET' && rest === 'snapshot') {
    const externalId = url.searchParams.get('externalId');
    const platform   = url.searchParams.get('platform');
    const gameSlug   = url.searchParams.get('gameSlug') || '26';
    if (!externalId || !platform) return badRequest('missing externalId/platform');
    const live = await fetchLiveAuctions(gameSlug, externalId, platform).catch(e => ({
      liveAuctions: [], lastUpdate: null, _error: String(e.message || e),
    }));
    const overall = await fetchOverallPrices(externalId).catch(() => null);
    const cheapestBin = live.liveAuctions.reduce(
      (m, a) => a.buyNowPrice != null && (m == null || a.buyNowPrice < m) ? a.buyNowPrice : m,
      null
    );
    return jsonResponse({
      cheapestBin,
      med: overall?.price?.[platform] ?? null,
      liveCount: live.liveAuctions.length,
      lastUpdate: live.lastUpdate,
      ...(live._error ? { error: live._error } : {}),
    });
  }

  // POST /api/u/<slug>/test — fire a test Discord message
  if (req.method === 'POST' && rest === 'test') {
    const webhook = user.discordWebhook || env.DISCORD_WEBHOOK;
    if (!webhook) return badRequest('no Discord webhook set (and no env fallback)');
    const ok = await postDiscord(webhook, {
      title: '🧪 Test alert',
      body:  'If you see this in Discord, your webhook is wired correctly.',
      color: 0x5865F2,
    });
    return jsonResponse({ ok });
  }

  // POST /api/u/<slug>/poll — manual poll trigger (limited to this user's watches)
  if (req.method === 'POST' && rest === 'poll') {
    // Run pollAll across everyone (cron does that anyway). Returns the global summary.
    const r = await pollAll(env);
    return jsonResponse(r);
  }

  return notFound();
}

// /api/admin/<rest>
async function handleAdminApi(req, env, url, rest) {
  if (!adminOk(req, env, url)) return adminUnauthorized();

  // POST /api/admin/migrate — legacy "watches" → user:matt-<slug>
  if (req.method === 'POST' && rest === 'migrate') {
    const legacyRaw = await env.WATCHES.get('watches');
    if (!legacyRaw) return jsonResponse({ ok: true, skipped: 'no legacy watches key' });
    const legacyWatches = JSON.parse(legacyRaw);
    const slug = 'matt-' + newSlug();
    await createUser(env, slug, { discordWebhook: '', watches: legacyWatches });
    await env.WATCHES.delete('watches');
    return jsonResponse({ ok: true, slug, migratedWatches: Object.keys(legacyWatches).length });
  }

  // GET /api/admin/users — list all users with summary
  if (req.method === 'GET' && rest === 'users') {
    const slugs = await listUsers(env);
    const users = [];
    for (const slug of slugs) {
      const u = await loadUser(env, slug);
      if (u) users.push({
        slug,
        watchCount:   Object.keys(u.watches).length,
        webhookSet:   !!u.discordWebhook,
        createdAt:    u.createdAt,
        lastSeenAt:   u.lastSeenAt,
      });
    }
    return jsonResponse({ users });
  }

  // DELETE /api/admin/users/<slug>
  if (req.method === 'DELETE' && rest.startsWith('users/')) {
    const slug = rest.slice('users/'.length);
    await deleteUser(env, slug);
    return jsonResponse({ ok: true });
  }

  return notFound();
}

// POST /api/new-user — create a fresh empty user, return slug
async function handleNewUser(env) {
  const slug = newSlug();
  await createUser(env, slug);
  return jsonResponse({ slug });
}
```

Also delete the old `// One-shot cleanup of orphaned seen:* KV keys` route (lines ~291-301) — that work is done and the route is no longer relevant. Delete the `checkAuth` helper at line 199-202 (replaced by `adminOk`). Delete the old `unauthorized()` helper (replaced by `adminUnauthorized`/`notFound`).

- [ ] **Step 3: Replace the `fetch` entrypoint to route by path shape**

In the `export default` block (around line 308), replace `fetch` with:

```javascript
  async fetch(req, env) {
    const url = new URL(req.url);
    const p   = url.pathname;

    // API routes
    if (p === '/api/new-user' && req.method === 'POST') return handleNewUser(env);

    let m;
    if ((m = p.match(/^\/api\/u\/([^/]+)\/(.+)$/))) return handleUserApi(req, env, url, m[1], m[2]);
    if ((m = p.match(/^\/api\/admin\/(.+)$/)))      return handleAdminApi(req, env, url, m[1]);

    // UI routes — these are added in Task 9. For now, return 404 for any non-API path.
    return new Response('Not found', { status: 404 });
  },
```

(Task 9 will add the `/`, `/u/<slug>`, `/admin` UI routes. After this commit, the UI is broken until Task 9 ships — which is why Tasks 7-11 must deploy together.)

- [ ] **Step 4: Local verification (API only)**

```bash
cd /c/Users/mcros/mutgg-alerts/worker
echo 'AUTH_SECRET = "testsecret"' > .dev.vars
npx wrangler dev --local

# Create a user
curl -X POST "http://localhost:8787/api/new-user"
# Expected: {"slug":"<16-char-slug>"}

SLUG=<paste-the-slug>

# Read watches (empty)
curl "http://localhost:8787/api/u/$SLUG/watches"
# Expected: {"watches":{},"discordWebhook":""}

# Bad slug → 404
curl "http://localhost:8787/api/u/doesnotexist/watches"
# Expected: {"error":"not found"} status 404

# Admin auth
curl "http://localhost:8787/api/admin/users?key=testsecret"
# Expected: {"users":[{"slug":"...","watchCount":0,...}]}

curl "http://localhost:8787/api/admin/users"
# Expected: {"error":"unauthorized"} status 401

# Delete user
curl -X DELETE "http://localhost:8787/api/admin/users/$SLUG?key=testsecret"
# Expected: {"ok":true}

rm .dev.vars
```

Stop wrangler dev.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
feat(worker): multi-tenant API routes (/api/u/<slug>/*, /api/admin/*)

Replaces single-tenant AUTH_SECRET-gated /api/* with per-user
routes where the slug IS the auth token. Admin routes still
gated by AUTH_SECRET. Deletes loadWatches/saveWatches and the
orphan /api/cleanup-seen route.

NOTE: UI is broken until Task 9 lands (next commit). Tasks 7-11
must deploy together.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Refactor UI script to use slug-based routes

The embedded UI currently fetches `/api/watches` with an `X-Auth` header carrying `AUTH_SECRET`. Rewrite it to derive its slug from `window.location.pathname` and call `/api/u/<slug>/*` without any auth header. Add a Discord webhook settings field.

**Files:**
- Modify: `worker/src/index.js` (the `UI_HTML` template literal at the bottom of the file, ~line 322-587)

- [ ] **Step 1: Update the inline `<script>` section of `UI_HTML`**

Inside `UI_HTML`, find `<script>` (around line 426). Replace the helpers (the `auth()` and `api()` functions, lines ~431-441) with:

```javascript
const SLUG = window.location.pathname.match(/^\/u\/([^/]+)/)?.[1];
if (!SLUG) { document.body.innerHTML = '<p style="padding:24px">Invalid URL.</p>'; throw new Error('no slug'); }
const API = path => '/api/u/' + SLUG + path;

async function api(path, opts = {}) {
  const r = await fetch(API(path), { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 404 && (await r.clone().json()).error === 'not found' && path === '/watches') {
    document.body.innerHTML = '<p style="padding:24px">This watch list doesn\\'t exist. <a href="/" style="color:#7ed996">Create a new one</a>.</p>';
    throw new Error('not found');
  }
  return await r.json();
}
```

Replace every other call site in the script that hits `/api/...`:

| Old | New |
|---|---|
| `api('/api/search?name=...')` | `api('/search?name=...')` |
| `api('/api/watches')` (GET) | `api('/watches')` |
| `api('/api/watches', { method:'POST', ... })` | `api('/watches', { method:'POST', ... })` |
| `api('/api/watches/' + id, { method:'DELETE' })` | `api('/watches/' + id, { method:'DELETE' })` |
| `api('/api/snapshot?...')` | `api('/snapshot?...')` |
| `api('/api/test', { method:'POST' })` | `api('/test', { method:'POST' })` |
| `api('/api/poll', { method:'POST' })` | `api('/poll', { method:'POST' })` |

Use editor find-and-replace inside the UI_HTML template literal. After replacements, no `'/api/` strings should remain inside `UI_HTML`.

- [ ] **Step 2: Add a Discord webhook settings card to the UI HTML**

Inside `UI_HTML`, locate the existing `<div class="card">` for the add-watch form (around line 377). **Before** it (so settings appear at the top), insert:

```html
<div class="card" id="settings-card">
  <div class="row" style="gap:12px; align-items:flex-end;">
    <div class="grow">
      <label>Discord webhook URL</label>
      <input id="f-webhook" type="url" placeholder="https://discord.com/api/webhooks/...">
    </div>
    <button id="btn-save-webhook" class="primary" type="button">Save</button>
  </div>
  <div id="webhook-status" class="status muted">Loading…</div>
</div>
```

In the `<script>` section, **after** the `const fmt = …` line near the top, add:

```javascript
async function loadSettings() {
  const r = await api('/watches');
  $('#f-webhook').value = r.discordWebhook || '';
  $('#webhook-status').textContent = r.discordWebhook ? 'Webhook configured.' : 'No webhook set — alerts will use the server fallback if available.';
  $('#webhook-status').className = 'status muted';
}
$('#btn-save-webhook').onclick = async () => {
  const v = $('#f-webhook').value.trim();
  const s = $('#webhook-status'); s.className = 'status'; s.textContent = 'Saving…';
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ discordWebhook: v }) });
    s.className = 'status ok'; s.textContent = 'Saved.';
  } catch (e) { s.className = 'status err'; s.textContent = 'Failed: ' + e.message; }
};
loadSettings();
```

- [ ] **Step 3: Local verification deferred to Task 9**

The UI is served only at `/u/<slug>` which doesn't exist yet — added in Task 9. Don't try to verify this task standalone. Just commit and move on.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
feat(worker-ui): derive slug from URL, drop AUTH_SECRET, add webhook field

UI script derives slug from /u/<slug> URL, fetches /api/u/<slug>/*
with no auth header. New settings card lets each user set their
own Discord webhook URL (stored in user record).

UI still not served until Task 9 adds the GET / and /u/<slug> routes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add landing page + serve user UI at `/u/<slug>`

Wire up the three remaining `fetch` routes: `GET /` (landing page with "Create my watch list" button), `GET /u/<slug>` (serves `UI_HTML` if slug exists, 404 page if not), and `GET /admin` (placeholder for Task 10).

**Files:**
- Modify: `worker/src/index.js` (the `fetch` entrypoint in the `export default` block; also add a `LANDING_HTML` and `NOT_FOUND_HTML` near `UI_HTML`)

- [ ] **Step 1: Add landing-page and 404-page HTML strings**

Near the top of `UI_HTML` (immediately before its `const UI_HTML = ...` line), add:

```javascript
const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MUT.GG Auction Alerts</title>
<style>
:root { color-scheme: dark; }
body { background:#0b0f12; color:#e7e9ea; font:14px/1.45 system-ui,sans-serif; margin:0; padding:48px 24px; max-width:560px; margin-inline:auto; text-align:center; }
h1 { font-size:28px; margin:0 0 12px; }
p { color:#9aa3ad; margin:0 0 16px; }
button { background:#1f5b3a; color:#e7e9ea; border:1px solid #2a7a4d; border-radius:8px; padding:14px 28px; font:600 15px system-ui,sans-serif; cursor:pointer; }
button:hover { background:#2a7a4d; }
.warn { color:#677079; font-size:12px; margin-top:24px; }
</style>
</head><body>
<h1>🔔 MUT.GG Auction Alerts</h1>
<p>Always-on auction sniping. Polls mut.gg every minute, pings your Discord when BIN drops to your target.</p>
<button id="go" type="button">Create my watch list</button>
<p class="warn">Bookmark the URL we send you. Anyone with the link can edit it, so don't share it publicly.</p>
<script>
document.getElementById('go').onclick = async () => {
  const r = await fetch('/api/new-user', { method: 'POST' });
  const { slug } = await r.json();
  location.href = '/u/' + slug;
};
</script>
</body></html>`;

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Not found</title>
<style>body{background:#0b0f12;color:#e7e9ea;font:14px system-ui,sans-serif;padding:48px;text-align:center;max-width:480px;margin:auto}a{color:#7ed996}</style>
</head><body>
<h1>This watch list doesn't exist.</h1>
<p><a href="/">Create a new one</a></p>
</body></html>`;
```

- [ ] **Step 2: Replace the `fetch` entrypoint**

Replace the `fetch` method in the `export default` block with:

```javascript
  async fetch(req, env) {
    const url = new URL(req.url);
    const p   = url.pathname;

    // --- API routes ---
    if (p === '/api/new-user' && req.method === 'POST') return handleNewUser(env);

    let m;
    if ((m = p.match(/^\/api\/u\/([^/]+)\/(.+)$/))) return handleUserApi(req, env, url, m[1], m[2]);
    if ((m = p.match(/^\/api\/admin\/(.+)$/)))      return handleAdminApi(req, env, url, m[1]);

    // --- UI routes ---

    // GET /  → landing page
    if (p === '/' && req.method === 'GET') {
      return new Response(LANDING_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // GET /u/<slug>  → user UI (or 404 page if slug doesn't exist)
    if ((m = p.match(/^\/u\/([^/]+)\/?$/)) && req.method === 'GET') {
      const slug = m[1];
      const user = await loadUser(env, slug);
      if (!user) {
        return new Response(NOT_FOUND_HTML, {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // GET /admin → admin page (Task 10 adds the HTML; for now respond 501)
    if (p === '/admin' && req.method === 'GET') {
      return new Response('admin UI coming in Task 10', { status: 501 });
    }

    return new Response('Not found', { status: 404 });
  },
```

- [ ] **Step 3: Local verification (full UI flow)**

```bash
cd /c/Users/mcros/mutgg-alerts/worker
echo 'AUTH_SECRET = "testsecret"' > .dev.vars
npx wrangler dev --local
```

Open `http://localhost:8787/` in a browser. Expected: landing page with green "Create my watch list" button.

Click the button. Expected: redirect to `/u/<slug>`, see the watch-list UI with empty state ("No watches yet").

In the URL bar, type a player name (e.g., "Hill"), pick a program from the dropdown, set platform PC, target 1000000, click "Add watch". Expected: watch appears in the log below. BIN value populates async.

Set a Discord webhook URL (use a real one from your test server or paste your existing webhook), click Save. Expected: "Saved." status. Click "Test Discord". Expected: message arrives in your Discord channel.

Visit `http://localhost:8787/u/doesnotexist`. Expected: dark "This watch list doesn't exist" page with link to `/`.

```bash
rm .dev.vars
```

Stop wrangler dev.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
feat(worker): serve landing page, per-user UI, 404 page

GET /        → landing with 'Create my watch list' → POST /api/new-user
GET /u/<slug>→ existing UI (slug-scoped) or 404 page if slug not found
GET /admin   → placeholder, real UI added in next commit

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Add admin page UI

`GET /admin?key=<AUTH_SECRET>` renders a table of all users with watch counts, webhook status, last-seen, and per-row delete buttons. Replaces the Task 9 placeholder.

**Files:**
- Modify: `worker/src/index.js` (add `ADMIN_HTML` near other HTML strings; update the `/admin` route in `fetch`)

- [ ] **Step 1: Add `ADMIN_HTML`**

Near `LANDING_HTML`, add:

```javascript
const ADMIN_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MUT.GG Alerts — admin</title>
<style>
:root { color-scheme: dark; }
body { background:#0b0f12; color:#e7e9ea; font:14px/1.45 system-ui,sans-serif; margin:0; padding:24px; max-width:920px; margin-inline:auto; }
h1 { font-size:20px; margin:0 0 16px; }
table { width:100%; border-collapse:collapse; }
th, td { padding:10px 12px; text-align:left; border-bottom:1px solid #232b33; font-size:13px; }
th { color:#9aa3ad; font-size:11px; text-transform:uppercase; letter-spacing:.5px; }
.slug { font:12px ui-monospace,monospace; color:#7ed996; }
button { background:#5b1f1f; color:#e7e9ea; border:1px solid #7a2a2a; border-radius:6px; padding:5px 10px; cursor:pointer; font-size:12px; }
.muted { color:#677079; }
</style>
</head><body>
<h1>👑 Admin · Users</h1>
<div id="status"></div>
<table id="t"><thead><tr>
  <th>Slug</th><th>Watches</th><th>Webhook</th><th>Created</th><th>Last seen</th><th></th>
</tr></thead><tbody></tbody></table>
<script>
const key = new URLSearchParams(location.search).get('key');
if (!key) { document.body.innerHTML = '<p style="padding:24px">Missing <code>?key=</code> query param.</p>'; }
async function load() {
  const r = await fetch('/api/admin/users?key=' + encodeURIComponent(key));
  if (r.status === 401) { document.body.innerHTML = '<p style="padding:24px">Unauthorized.</p>'; return; }
  const { users } = await r.json();
  const tb = document.querySelector('#t tbody');
  tb.innerHTML = '';
  for (const u of users.sort((a,b) => (b.lastSeenAt||0) - (a.lastSeenAt||0))) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><a class="slug" href="/u/' + u.slug + '">' + u.slug + '</a></td>' +
      '<td>' + u.watchCount + '</td>' +
      '<td>' + (u.webhookSet ? '✓' : '<span class="muted">env fallback</span>') + '</td>' +
      '<td class="muted">' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—') + '</td>' +
      '<td class="muted">' + (u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : '—') + '</td>' +
      '<td><button data-slug="' + u.slug + '">Delete</button></td>';
    tr.querySelector('button').onclick = async () => {
      if (!confirm('Delete user ' + u.slug + ' and all their watches?')) return;
      await fetch('/api/admin/users/' + u.slug + '?key=' + encodeURIComponent(key), { method: 'DELETE' });
      load();
    };
    tb.appendChild(tr);
  }
}
load();
</script>
</body></html>`;
```

- [ ] **Step 2: Wire up the `/admin` route**

In `fetch`, replace the placeholder admin route with:

```javascript
    // GET /admin → admin UI (the page itself fetches /api/admin/users using ?key=)
    if (p === '/admin' && req.method === 'GET') {
      return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
```

- [ ] **Step 3: Local verification**

```bash
cd /c/Users/mcros/mutgg-alerts/worker
echo 'AUTH_SECRET = "testsecret"' > .dev.vars
npx wrangler dev --local
```

Browser:
1. Visit `http://localhost:8787/` → click "Create my watch list" twice in two browser tabs → two slugs exist.
2. Visit `http://localhost:8787/admin?key=testsecret` → see both users listed, watch count 0, webhook "env fallback", last-seen recent.
3. Click "Delete" on one user → confirm → row disappears.
4. Visit `http://localhost:8787/admin` (no key) → "Missing ?key=" page.
5. Visit `http://localhost:8787/admin?key=wrong` → "Unauthorized" page.

```bash
rm .dev.vars
```

Stop wrangler dev.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.js
git commit -m "$(cat <<'EOF'
feat(worker): admin page (list/delete users)

GET /admin?key=<AUTH_SECRET> renders a table of all users with
watch count, webhook status, last-seen, and per-row delete.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Update repo README to reflect new model

The main `README.md` and `worker/README.md` describe the old single-tenant flow. Update them so any future user (or future-you) understands the shareable model.

**Files:**
- Modify: `README.md`
- Modify: `worker/README.md` (check first; may not need changes if it's deploy-focused)

- [ ] **Step 1: Read both READMEs to see what needs updating**

Run:
```bash
cat /c/Users/mcros/mutgg-alerts/README.md
echo "---"
cat /c/Users/mcros/mutgg-alerts/worker/README.md
```

- [ ] **Step 2: Update top-level README**

In `README.md`, update the "How it works" and "Quick start" sections so the user model reflects per-slug, multi-tenant. Specifically:

- Add a "Sharing" section after "How it works": "Visit `<your worker URL>/` and click 'Create my watch list' to get your own slug-keyed page. Share the URL only with people you want to grant edit access to. Admin overview at `/admin?key=<AUTH_SECRET>`."
- Remove `wrangler secret put DISCORD_WEBHOOK` from the quick-start (now optional — only used as a fallback for users without their own webhook). Make it clear that each user sets their own webhook in their UI.
- Drop the "single shared `DISCORD_WEBHOOK` + `AUTH_SECRET` for everyone" implication.

Keep the file under 100 lines; this is a hobby project README, not docs.

- [ ] **Step 3: Spot-update `worker/README.md` if needed**

If it has any "single shared watch list" language, fix it. If it's purely deploy/wrangler instructions, leave it alone.

- [ ] **Step 4: Commit**

```bash
git add README.md worker/README.md
git commit -m "$(cat <<'EOF'
docs: update README for shareable multi-tenant model

Each user creates their own slug-keyed watch list via the landing
page. Admin overview at /admin?key=<AUTH_SECRET>. DISCORD_WEBHOOK
secret is now optional (per-user fallback).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Deploy, migrate, verify

The whole multi-tenant refactor (Tasks 4-11) is now on `main`. Deploy and run the live migration.

**Files:** none modified

- [ ] **Step 1: Deploy**

```bash
cd /c/Users/mcros/mutgg-alerts/worker
npm run deploy
```

Expected: `Published mutgg-alerts (X.XXs)` with the workers.dev URL.

- [ ] **Step 2: Confirm landing page loads**

Open `https://mutgg-alerts.mrosale2.workers.dev/` in a browser. Expected: dark landing page with green "Create my watch list" button.

DO NOT click it yet. The legacy `watches` key still holds your watches — migrate them first.

- [ ] **Step 3: Run migration**

```bash
AUTH_SECRET=$(cat /c/Users/mcros/mutgg-alerts/.auth-secret-NEW-DELETE-AFTER-SAVING.txt)
curl -X POST "https://mutgg-alerts.mrosale2.workers.dev/api/admin/migrate?key=$AUTH_SECRET"
```

Expected: `{"ok":true,"slug":"matt-XXXXXXXXXXXXXXXX","migratedWatches":N}` where N matches your current watch count.

**Save the slug.** That's your URL.

- [ ] **Step 4: Verify your migrated UI**

Open `https://mutgg-alerts.mrosale2.workers.dev/u/matt-<slug>` in a browser. Expected: all your existing watches render with OVR + program + platform + target.

Set your Discord webhook in the new settings card (paste your existing webhook URL — find it via the Discord channel's Integrations → Webhooks). Click Save. Click Test Discord. Expected: test message arrives in Discord.

- [ ] **Step 5: Verify admin**

Open `https://mutgg-alerts.mrosale2.workers.dev/admin?key=<AUTH_SECRET>`. Expected: one row, your slug, correct watch count, webhook ✓, last-seen recent.

- [ ] **Step 6: Watch live cron**

```bash
cd /c/Users/mcros/mutgg-alerts/worker
npx wrangler tail
```

Wait ~3 min (3 cron ticks). Expected: each tick logs the dedup summary (`uniqueFetches: N`); some ticks log `fetchJson retry:` lines and recover. No tick errors out completely.

- [ ] **Step 7: Smoke-test friend onboarding**

From an incognito tab, visit `https://mutgg-alerts.mrosale2.workers.dev/`, click "Create my watch list", confirm you land on a fresh `/u/<slug>` with empty state. Add a test watch. Visit `/admin?key=<AUTH_SECRET>` → confirm the new user appears as a second row, completely isolated from your watches.

Then delete the test user via the admin page.

- [ ] **Step 8: Push and call it done**

```bash
cd /c/Users/mcros/mutgg-alerts
git push origin main
```

DM friends their slug URLs as they want in. Bookmark your own URL.

- [ ] **Step 9: Update Matt's auto-memory**

After deploy is verified working, update memory files to reflect the new model. (You can ask Claude to do this in the same session: "update my memory to reflect the new shareable mutgg-alerts model.")

Specifically the `reference_mutgg_alerts.md` memory needs:
- KV layout description updated (per-user keys, not single blob)
- AUTH_SECRET role updated (admin-only, not gate for all routes)
- Note that each user has own webhook; env `DISCORD_WEBHOOK` is fallback
- Note retry-with-backoff behavior

---

## Self-Review Summary

**Spec coverage:** Every spec section has a task — routing (Task 7+9), auth model (Task 7), per-user KV (Task 4), cron loop (Task 5), reliability fixes (Tasks 2+3), UI deltas (Task 8), admin page (Task 10), 404 behavior (Task 9), migration (Task 6+12), rollout (Task 12). ✓

**Placeholder scan:** All code blocks present, all commands have expected output, no "TBD"/"similar to". ✓

**Type consistency:** `loadUser`/`saveUser`/`createUser`/`deleteUser`/`listUsers`/`newSlug` signatures consistent across Tasks 4, 5, 6, 7, 9, 10. `handleUserApi(req, env, url, slug, rest)` signature matches its call site in Task 9's `fetch`. UI's `API(path)` helper matches the route shapes defined in Task 7. ✓

**Watch-out:** Task 7 deletes the old API routes but UI isn't fixed until Task 8 and not served until Task 9. Tasks 7-11 must ship as one deploy. Plan explicitly calls this out in Task 7 Step 5 commit message.
