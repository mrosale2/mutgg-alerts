# mut.gg auction alerts

Always-on auction sniping for [mut.gg](https://www.mut.gg). A Cloudflare Worker polls mut.gg every minute, checks your watch list, and pings a Discord channel (and your phone via the Discord app) when a player's BIN drops to your target price.

**No browser tab required.** Set up once, runs forever in the cloud. You open a web UI only when you want to add/edit/remove watches.

---

## How it works

1. **Cloudflare Worker** — runs on a 1-minute cron. For each watch, it hits mut.gg's public `prices` endpoint, looks at the current `liveAuctions`, and if a new listing has `BIN ≤ target`, it posts to your Discord webhook.
2. **Discord webhook** — your channel ping, with your phone notification handled by the Discord mobile app. No extra service required.
3. **Web UI** — served by the Worker itself at its `*.workers.dev` URL. Add a watch by typing a player name; the program dropdown auto-populates with that player's available cards. Set a target price + recurring toggle. Done.

The UI mirrors the alert-log design: cards show **OVR · Name · Program · Platform · BIN · MED · TARGET · Recurring pill · Last-alerted timestamp**.

---

## Repo layout

```
mutgg-alerts/
├── worker/                          # the always-on Cloudflare Worker (primary)
│   ├── src/index.js                 # cron handler + HTTP API + embedded UI
│   ├── wrangler.toml                # Worker config (KV binding, cron schedule)
│   ├── package.json                 # wrangler dev dependency
│   └── README.md                    # full deploy walkthrough
│
├── bookmarklet/                     # legacy in-tab tool (kept for quick checks)
│   ├── mutgg-alerts.user.js
│   ├── mutgg-alerts.bookmarklet.txt
│   ├── install.html
│   └── build-bookmarklet.cjs
│
└── README.md                        # you are here
```

---

## Quick start

Full step-by-step is in **[worker/README.md](worker/README.md)**. The short version:

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create WATCHES   # paste id into wrangler.toml
npx wrangler secret put DISCORD_WEBHOOK    # paste your Discord webhook URL
npx wrangler secret put AUTH_SECRET        # any random string
npm run deploy
```

Wrangler prints the deployed URL (e.g. `https://mutgg-alerts.<your-subdomain>.workers.dev`). Open it, enter your `AUTH_SECRET` when prompted, hit **Test Discord** to verify, then start adding watches.

---

## Endpoints decoded from mut.gg (anonymous, no auth)

- `GET /api/mutdb/player-items/?name=<lastname>` — player search
- `GET /api/mutdb/prices/<gameSlug>-<externalId>/<platform>/` — live auctions + recent sales
- `GET /api/mutdb/prices/overall/playeritem/?external_ids=<id>` — median price per platform

Platforms: `pc`, `xbox-series-x`, `playstation-5`. Current game slug is `26` (Madden NFL 26).

---

## Legacy bookmarklet

The `bookmarklet/` subdir has the older in-tab tool. It only polls while a mut.gg tab is open, so it's strictly less useful than the Worker — but you can install it as a quick ad-hoc check without needing Cloudflare. See `bookmarklet/install.html`.

---

## License

Use it, fork it, share it. No warranty.
