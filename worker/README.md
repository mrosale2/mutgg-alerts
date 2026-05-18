# Cloudflare Worker — always-on alerts

This is the brain. A Cloudflare Worker that runs on a 1-minute cron, polls mut.gg for the watches you've configured, and pings a Discord webhook when a live auction's BIN is at or below your target price.

**No browser tab required.** The Worker runs in Cloudflare's edge network forever. You only open the web UI when you want to add, edit, or remove watches.

The Worker also serves the management UI at its root URL — same deploy, one place to go.

---

## What runs where

| Piece | Where | Why |
|---|---|---|
| `scheduled()` cron handler | Cloudflare Workers (every 1 min) | Polls mut.gg, fires Discord alert when cheapest BIN beats `lastAlertedPrice`. |
| `fetch()` HTTP API | Cloudflare Workers | Serves the UI HTML; exposes `/api/*` for CRUD on watches. |
| Watches + dedup state | Cloudflare KV (free tier) | `watches` key holds all configs; `seen:<id>` tracks recently-seen listings per watch. |
| Discord delivery | Discord webhook | Standard JSON POST. Push to phone via Discord app. |
| Player search | mut.gg's anonymous `?name=` API | No auth required. |
| Live auctions | mut.gg's anonymous prices endpoint | Same. |

---

## Deploy (one-time, ~10 minutes)

### 1. Install Wrangler

[Wrangler](https://developers.cloudflare.com/workers/wrangler/) is Cloudflare's CLI. Requires Node.js.

```bash
cd worker
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

Browser opens, you authorize, done. Free Cloudflare account works.

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create WATCHES
```

Output looks like:

```
{ binding = "WATCHES", id = "abc123def456..." }
```

Copy the `id` value into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 4. Set the secrets

```bash
# Your Discord webhook URL (right-click channel → Edit Channel → Integrations → Webhooks → New)
npx wrangler secret put DISCORD_WEBHOOK

# A random string to gate the UI; pick anything hard to guess
npx wrangler secret put AUTH_SECRET
```

You'll be prompted to paste the value. The secrets are stored encrypted in Cloudflare — they never appear in the repo.

### 5. Deploy

```bash
npm run deploy
```

Wrangler prints the URL, something like `https://mutgg-alerts.<your-subdomain>.workers.dev`.

### 6. Open the UI

Visit the URL. You'll be prompted for `AUTH_SECRET` once; the browser caches it in `localStorage`. Click **Test Discord** to verify the webhook works. Add a watch.

The cron handler fires every minute automatically — no further action needed.

---

## Local development

```bash
npm run dev
```

Starts Wrangler in dev mode at `http://localhost:8787` with hot reload. The cron doesn't fire in dev mode, but you can trigger a poll manually:

```bash
curl -X POST http://localhost:8787/api/poll -H "X-Auth: <your-AUTH_SECRET>"
```

To stream production logs after deploying:

```bash
npm run tail
```

---

## API reference

All routes except `GET /` require header `X-Auth: <AUTH_SECRET>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Serve the management UI. |
| `GET` | `/api/watches` | List all watches with their last-poll metadata. |
| `POST` | `/api/watches` | Create or update a watch. Body: `{ externalId, gameSlug, url, name, program, ovr, platform, targetBin, recurring }`. |
| `DELETE` | `/api/watches/:id` | Remove a watch (`id` is `<externalId>-<platform>`). |
| `GET` | `/api/search?name=X` | Proxy mut.gg's player search; returns auctionable cards. |
| `GET` | `/api/snapshot?externalId=...&platform=...` | Returns `{ cheapestBin, med, liveCount, lastUpdate }` for one card. Used by the UI to populate BIN/MED on alert cards. |
| `POST` | `/api/test` | Fire a test alert through the Discord webhook. |
| `POST` | `/api/poll` | Manually trigger a poll cycle (useful for testing without waiting for cron). |

---

## Costs

Workers Paid plan ($5/mo) — bundled quotas easily cover this workload:

- **Workers:** 10M requests/month included. Cron is 1 request per fire = 1,440/day. Subrequests inside the cron count separately (1,000/invocation cap) — with N unique watched cards per tick, usage = N mut.gg fetches + alerts that fire. At 100 watches you'd use ~100/1,000.
- **KV:** 10M reads, 1M writes, 1 GB storage per month. Current design writes the watches blob once per tick = 1,440/day, well under the ~33k/day equivalent.
- **Discord webhooks:** free. Discord rate-limits ~30 msg/min per webhook — only matters if you're firing dozens of alerts a minute.

---

## How the alert rule works

Per poll, for each watch we take the **cheapest** live auction below `targetBin`. We fire the alert only when that price is *strictly cheaper* than the last price we ever alerted at for this watch (`lastAlertedPrice`, persisted on the watch in KV).

This means:
- The same listing across two polls fires once, not twice.
- A new listing at or above the last alerted price stays silent — even if it's still below target.
- A new listing that beats the last alerted price fires immediately.
- Resetting alerts on a watch = clear `lastAlertedPrice` (delete + re-add the watch is the easiest way today).

State lives on the watch object itself (`lastAlertedAt`, `lastAlertedPrice`). There is no separate `seen:*` KV key — earlier versions used one and `/api/cleanup-seen` exists to sweep up the orphans, but new deploys never write them.
