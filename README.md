# MUT.GG Auction Alerts

A free bookmarklet that watches [mut.gg](https://www.mut.gg) for live auctions on selected players and pushes alerts to Discord (which pushes to your phone) when an auction matching your criteria appears.

> **Standalone project.** This repo is for the mut.gg alert tool only. It is **not** related to other MUT pricing/sniping tools — different site, different APIs, different delivery model. It uses only mut.gg's public, anonymous endpoints.

---

## What it does

- **Watch a player + program combo** — e.g., "Tyreek Hill, Sugar Rush, PC, alert when BIN ≤ 400,000 coins."
- **Polls mut.gg every ~2.5 minutes** while a mut.gg tab is open in your browser.
- **Sends a Discord webhook ping** when a matching new listing appears. Discord on your phone handles the push notification — no extra app required if you already use Discord.
- **Falls back to / supplements with** in-tab browser notifications, audio beep, and [ntfy.sh](https://ntfy.sh) if you'd rather not use Discord.

---

## Install (end user)

1. Open `install.html` in your browser (double-click the file, or serve it).
2. **Drag the "MUT.GG Auction Alerts" button to your bookmarks bar.** That's the entire install — the bookmark is the tool.
3. **One-time Discord setup:**
   - In Discord, pick a channel you control (a private server takes 30 seconds to create).
   - Right-click the channel → **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**.
   - On any mut.gg page, click your new bookmark. Expand **⚙️ Alert delivery**, paste the URL into "Discord URL", hit **Save**, then **Test**. A test message should land in your Discord channel within a second.
   - On your phone, enable notifications for that channel (long-press → Notifications → All Messages).
4. **Add a watch:** click the bookmark on any mut.gg page, fill in:
   - **Player** — full name, e.g. `Tyreek Hill`
   - **Program** — partial match, e.g. `Sugar Rush`
   - **Platform** — PC, Xbox Series X, or PlayStation 5
   - **Alert ≤** — your price ceiling in coins (e.g. `400000`). Leave blank to alert on any new listing.
5. **Keep a mut.gg tab open** (pin it in the background). Polling runs only while the tab is open. Close all mut.gg tabs and polling stops until you click the bookmark again.

To share with someone else: send them `install.html`, or paste the contents of `mutgg-alerts.bookmarklet.txt` as the URL of a new bookmark.

---

## How it works

### Data sources

Two anonymous endpoints, decoded from mut.gg's JS bundle on 2026-05-10. No login required, no API key.

- **Search:**
  ```
  GET https://www.mut.gg/api/mutdb/player-items/?name=<lastname>
  ```
  Returns up to a few dozen `data[]` entries across programs. Each entry has `firstName`, `lastName`, `program.name`, `overall`, `externalId`, `gameSlug`, `canAuction`, `url`, `pcPriceDisplay`, etc. We resolve a user's "player + program" query client-side via case-insensitive substring match.

- **Live auctions:**
  ```
  GET https://www.mut.gg/api/mutdb/prices/<gameSlug>-<externalId>/<platform>/
  ```
  Platforms: `pc`, `xbox-series-x`, `playstation-5`. Returns `data.pricesData.liveAuctions[]` with `buyNowPrice`, `currentBid`, `startingBid`, `endDate`, `bidCount`. The response also includes `lastUpdate` and an `authenticated` flag (always `false` for our use).

### Detection logic

Each watch keeps a `seenKeys` set — fingerprints of `(endDate, buyNowPrice, startingBid)` from the last poll. On the next poll, any auction whose fingerprint isn't in `seenKeys` is "new." If the user set a max-BIN threshold, we filter to listings ≤ threshold. Then we fire the alert.

First-poll-after-add is suppressed (otherwise we'd alert on every pre-existing listing immediately).

### Delivery

- **Discord webhook** — `POST <webhook_url>` with `{embeds: [{title, description, url, color, timestamp}]}`. Pure JSON, no auth header, CORS-friendly.
- **ntfy.sh** — `POST https://ntfy.sh/` with `{topic, title, message, click}` as JSON. (Header-based publishing is avoided because the alert title contains emoji which violates HTTP header ISO-8859-1 restrictions.)
- **In-tab fallback** — Web Notification API + audio beep, fires alongside the above.

### State

Everything is in `localStorage` under the key `mutgg-alerts.v1`. Watches, delivery config, last-seen fingerprints — all persisted there per browser per origin.

---

## Files

| File | Purpose |
|---|---|
| `mutgg-alerts.user.js` | Source code. Tampermonkey/Violentmonkey-compatible userscript. Also the body that gets wrapped into the bookmarklet. |
| `mutgg-alerts.bookmarklet.txt` | Built bookmarklet — single `javascript:` URI (~30 KB). Paste as the URL of a new bookmark. |
| `install.html` | Self-contained install page with a drag-to-bookmark button, Discord webhook setup walkthrough, and a copy-to-clipboard share helper. |
| `build-bookmarklet.cjs` | Build script. Reads `mutgg-alerts.user.js`, strips the userscript header, percent-encodes the body, regenerates `mutgg-alerts.bookmarklet.txt` and `install.html`. Run with `node build-bookmarklet.cjs`. |

---

## Development

No build system, no dependencies, no transpiler. Plain vanilla JS in one file.

To make a change:

1. Edit `mutgg-alerts.user.js`.
2. Run `node build-bookmarklet.cjs` to regenerate the bookmarklet and install page.
3. Test by serving the dir locally and injecting into a mut.gg page (the bookmarklet, the userscript, or `<script src>` for quick iteration).

### Testing notes

- **mut.gg's `?name=` search returns matches.** Other plausible params (`?search=`, `?last_name=`, etc.) silently return the default top-OVR list — meaning bad queries fail open, not closed. Use `?name=` only.
- **Auction data refreshes hourly-ish** on mut.gg's side (see `data.lastUpdate`). New listings appearing in the JSON lag actual EA auction-house listings by some minutes — this is a snapshot lag we can't eliminate.
- **HTTP header values are ASCII-only.** Notification titles contain emoji, so we publish to ntfy via JSON body, not headers. Discord's webhook accepts UTF-8 JSON natively — no issue there.
- **Userscript matchers:** `@match https://www.mut.gg/*` and `https://mut.gg/*`.

---

## Limitations

- **Tab must stay open.** A bookmarklet only runs while its host tab is alive. Close all mut.gg tabs → polling stops. Pin a tab in the background and forget about it.
- **Polling lag.** 2.5 min between polls + mut.gg's own data refresh cadence. This is not a 0-second auction sniper — it's an "I want to know when X becomes available, within a few minutes" tool.
- **mut.gg endpoint stability.** The endpoints are inferred from the public JS bundle. If mut.gg renames or removes them, this breaks. Easy to re-decode if that happens (see `## How it works → Data sources`).

---

## License

Use it, fork it, share it. No warranty.
