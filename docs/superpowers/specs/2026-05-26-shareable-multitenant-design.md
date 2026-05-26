# Shareable Multi-Tenant Worker + Reliability Fix

**Date:** 2026-05-26
**Status:** Approved (pending spec review)

## Problem

Two issues, fixed in one deploy:

1. **Worker cron is broken.** mut.gg moved `/api/mutdb/prices/*` behind Cloudflare's adaptive bot-shield. The Worker's `fetchJson` (`worker/src/index.js:43`) gets a 403 with an HTML "Just a moment..." challenge body, throws, and the cron tick fails silently. Probed 2026-05-26: live-auctions endpoint returns 403 on the first hit and 200 on the retry from the same IP; the median endpoint (`/prices/overall/playeritem/`) returns 403 uniformly.
2. **Single-tenant.** The Worker exposes one shared watch list gated by `AUTH_SECRET`, alerting to one shared `DISCORD_WEBHOOK`. Friends can't use it without seeing/editing each other's watches and getting alerts in the wrong Discord.

## Goals

- Worker cron polls succeed reliably against the bot-shielded endpoints.
- Friends can each have their own watch list + their own Discord webhook on the same deployed Worker, with no account/password infrastructure.
- One deploy ships both changes.

## Non-Goals (YAGNI)

- Accounts, emails, passwords, OAuth.
- Rate limiting per user (friend-scale; trusted).
- Per-user analytics or usage tracking.
- In-app invite/sharing flow — Matt DMs URLs manually.
- Slug rotation or recovery (lose URL = create new list).
- Program-wide watches (separate spec already in `docs/superpowers/`).

## Architecture

### Routing

| Route | Behavior |
|---|---|
| `GET /` | Landing page. One "Create my watch list" button → POST `/api/new-user` → 302 to `/u/<slug>`. |
| `GET /u/<slug>` | Existing management UI, scoped to that user. 404 page if slug doesn't exist (no auto-create on direct visit). |
| `POST /api/u/<slug>/watches`, `DELETE /api/u/<slug>/watches/:key`, `PUT /api/u/<slug>/settings`, etc. | Existing API endpoints, scoped per user. |
| `POST /api/new-user` | Generates a fresh 16-char URL-safe random slug (~96 bits entropy via `crypto.getRandomValues`), creates empty user record, returns `{ slug }`. |
| `GET /admin?key=<AUTH_SECRET>` | Lists all users (slug, watch count, webhook-set yes/no, `lastSeenAt`). Per-row "Delete user" button. |
| `POST /admin/migrate?key=<AUTH_SECRET>` | One-time: reads legacy `watches` key, creates `user:matt-<rand>` with all of them + current `DISCORD_WEBHOOK` env value, writes `index:slug:matt-<rand>`, deletes legacy `watches` key. Idempotent (no-op if legacy key absent). |

### Auth model

- **Slug-as-capability.** The 16-char random slug in the URL is the only auth token. Whoever has the URL can read + edit. Same model as a Google Docs "anyone with the link" share.
- No `AUTH_SECRET` gate on `/u/<slug>` routes. `AUTH_SECRET` is kept only for `/admin*` routes.
- Friends are warned in the landing-page copy: "Anyone with the URL can edit. Don't share it publicly."

### KV layout

Single binding `WATCHES` (unchanged), two key namespaces:

```
user:<slug>           → JSON {
                          discordWebhook: string,     // empty string = fall back to env.DISCORD_WEBHOOK during transition
                          watches: { [watchKey]: watchObj },
                          createdAt: number,           // ms epoch
                          lastSeenAt: number,          // ms epoch, updated on any UI hit
                        }
index:slug:<slug>     → "1"   (marker; cron iterates via list({ prefix: "index:slug:" }))
```

`watchKey` stays `${externalId}-${platform}` (unchanged inside the per-user `watches` object).

Legacy `watches` key (top-level blob of all watches) is deleted by the migration endpoint after a successful import.

### Cron loop

```
async function pollAll(env):
  slugKeys = await env.WATCHES.list({ prefix: "index:slug:" })
  users   = await Promise.all(slugKeys.map(k => loadUser(env, k.name.slice("index:slug:".length))))

  // Cross-user dedup: one mut.gg fetch per unique (gameSlug, externalId, platform)
  // regardless of how many users watch it
  uniqueKeys = collect unique fetch keys across all users.watches
  liveByKey  = await Promise.all(uniqueKeys.map(fetchLiveAuctionsWithRetry))

  // Fan out results to each user's alert logic
  for user of users:
    for watch of user.watches:
      handle alert for watch using liveByKey[keyOf(watch)]
                                  and user.discordWebhook || env.DISCORD_WEBHOOK
    saveUser(env, user.slug, user)
```

### Reliability fixes (bundled in the same deploy)

1. **Retry-with-backoff in `fetchJson`.** Up to 3 tries with delays `[0, 2000, 5000]` ms. Retry only on `403`, `429`, or `5xx`. Other errors (4xx, network) throw immediately. Log retry attempts so `wrangler tail` shows the recovery pattern.
2. **Drop median fetch from cron.** `fetchOverallPrices` is no longer called from `pollAll`. Median is fetched lazily by the UI when rendering a card (existing endpoint `GET /api/u/<slug>/watch/:key/details` or similar), and a median failure renders the card with `MED: —` instead of breaking the cron tick. Cron no longer depends on the consistently-blocked median endpoint.

## UI Changes

### Landing page (`GET /`) — new, ~30 lines of HTML
- Headline: "Always-on MUT.GG auction alerts."
- One-paragraph explainer.
- One button: "Create my watch list" → POST `/api/new-user` → redirect.
- Warning line about share-link semantics.

### User page (`GET /u/<slug>`) — existing UI, three deltas
- "Discord webhook URL" input becomes a real settings field, not admin-only/hidden.
- "Test Discord" button uses the user's stored webhook.
- All other behavior (watch list, OVR filter, card rendering) unchanged.

### Admin page (`GET /admin?key=<AUTH_SECRET>`) — new, ~50 lines
- Table of all users: slug, watch count, webhook-set yes/no, `lastSeenAt`.
- Per-row "Delete user" button (DELETE `/api/u/<slug>` with admin key).
- Only thing `AUTH_SECRET` still gates.

### 404 behavior on `/u/<slug>` for nonexistent slug
- Renders "This watch list doesn't exist. [Create a new one]" link to `/`.
- Does NOT auto-create — prevents random URL-typing from spawning ghost users in KV.

## Error Handling

| Case | Behavior |
|---|---|
| mut.gg 403/429/5xx | Retry up to 3x with 0/2s/5s backoff. Final failure → `w.lastError = msg`, watch skipped this tick. |
| Median fetch fails | Non-fatal. UI shows `MED: —`. Cron unaffected (median no longer in cron path). |
| KV write fails | Throw — cron tick fails loudly, surfaces in `wrangler tail`. Better than silent state loss. |
| `/u/<slug>` with missing slug | 404 page with link to create new list. No auto-create. |
| `/admin*` without correct `AUTH_SECRET` | 401, no response body leakage. |
| `POST /api/new-user` slug collision | Vanishingly unlikely at 96 bits; on collision, regenerate once. |

## Testing (manual — no test framework in repo)

After deploy:

1. `GET /admin?key=<secret>` — confirm migrated user appears with all existing watch keys intact.
2. Visit new `/u/matt-<rand>` URL — watches render, OVR filter works, card data renders.
3. Set webhook in UI, hit "Test Discord" — message posts to your channel.
4. In incognito, hit `/` → "Create my watch list" → confirm fresh slug, empty list, completely isolated from yours.
5. Add a low-bar watch (e.g., common gold at BIN ≤ 1M). Wait one cron cycle. Confirm Discord alert fires.
6. `wrangler tail` for ~5 min — confirm retry-with-backoff fires on the first cron tick after a cold start and recovers on the second attempt.

## Rollout

1. Push the 5 unpushed commits (`f5eb8a7`, `acb6989`, `7c1fa88`, `8707ed0`, `857d0ba`) to `origin/main` for a clean baseline.
2. Implement the refactor in one branch: routing, KV layout, retry, drop-median-from-cron, landing page, admin page, migration endpoint.
3. `npm run deploy`.
4. Hit `POST /admin/migrate?key=<secret>` once. Verify via `/admin?key=<secret>`.
5. Bookmark new URL. DM friends slugs created via admin or `/api/new-user`.
6. Leave the `DISCORD_WEBHOOK` env secret in place as a fallback during transition; remove in a follow-up once all users have set their own.

## Open questions

None at write-time. All flagged design decisions resolved during brainstorming.
