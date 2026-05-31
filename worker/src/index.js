// MUT.GG Live Auction Alerts — Cloudflare Worker
//
// Two entrypoints:
//   - scheduled(): cron-triggered every 1 min, polls mut.gg and fires Discord alerts
//   - fetch():     HTTP API + serves the management UI
//
// State (Cloudflare KV, binding "WATCHES"):
//   key "watches"           → JSON { [id]: Watch }
//   key "seen:<watchId>"    → JSON string[]   (recent listing fingerprints, capped)
//   key "lastAlerted:<id>"  → ISO timestamp string
//
// Secrets:
//   DISCORD_WEBHOOK  — Discord channel webhook URL
//   AUTH_SECRET      — random string the UI sends as X-Auth on API calls

const MUTGG = 'https://www.mut.gg';
const POLL_TIMEOUT_MS = 8000;   // per request

const PLATFORMS = {
  'pc':              'PC',
  'xbox-series-x':   'Xbox Series X',
  'playstation-5':   'PlayStation 5',
};

// ---------- helpers ----------

const fmt = n => n == null
  ? '—'
  : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? Math.round(n / 1e3) + 'K'
  : '' + n;

// Browser-like headers so mut.gg's Cloudflare bot-shield doesn't 403 us
// (default Workers User-Agent is "Cloudflare-Workers" which gets flagged).
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.mut.gg/',
  'Origin':  'https://www.mut.gg',
};

async function fetchJson(url, init = {}) {
  // Per-status retry delays. 429 (rate limit) gets longer backoff than generic
  // transient errors; mut.gg may also send Retry-After which we'll honor if present.
  const BASE_DELAYS_MS = [0, 2000, 5000];      // for 403/5xx
  const RATE_DELAYS_MS = [0, 12000, 30000];    // for 429 — bigger backoff
  const RETRY_STATUSES  = new Set([403, 429, 500, 502, 503, 504]);
  let lastErr;
  let nextStatus = null;
  let retryAfterMs = 0;
  for (let attempt = 0; attempt < BASE_DELAYS_MS.length; attempt++) {
    const baseDelay = nextStatus === 429
      ? RATE_DELAYS_MS[attempt]
      : BASE_DELAYS_MS[attempt];
    const wait = Math.max(baseDelay, retryAfterMs);
    if (wait > 0) await new Promise(res => setTimeout(res, wait));
    retryAfterMs = 0;
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
      nextStatus = r.status;
      const ra = r.headers.get('retry-after');
      if (ra) {
        const sec = Number(ra);
        if (Number.isFinite(sec)) retryAfterMs = sec * 1000;
      }
      lastErr = new Error(`${url}: HTTP ${r.status} (attempt ${attempt + 1})`);
    } catch (e) {
      lastErr = e;
      if (attempt === BASE_DELAYS_MS.length - 1) break;
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

// Cap concurrent in-flight fetches. Pass an array of items and an async worker;
// only `limit` workers are running at a time. Avoids hammering mut.gg with 100
// parallel requests when polling a filter watch chunk.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

async function searchPlayer(name) {
  // mut.gg's only working search param is ?name=<surname>
  const tokens = String(name).trim().split(/\s+/);
  const last = tokens[tokens.length - 1] || name;
  const j = await fetchJson(`${MUTGG}/api/mutdb/player-items/?name=${encodeURIComponent(last)}`);
  return (j.data || []).filter(p => p.canAuction);
}

async function fetchLiveAuctions(gameSlug, externalId, platform) {
  const j = await fetchJson(`${MUTGG}/api/mutdb/prices/${gameSlug}-${externalId}/${platform}/`);
  return {
    liveAuctions: j.data?.pricesData?.liveAuctions || [],
    lastUpdate:   j.data?.lastUpdate || null,
  };
}

async function fetchOverallPrices(externalId) {
  // Returns median/representative price per platform; used to compute MED for cards.
  const j = await fetchJson(`${MUTGG}/api/mutdb/prices/overall/playeritem/?external_ids=${externalId}`);
  return (j.data || [])[0] || null;
}

// Batch median fetch: takes a list of externalIds and returns a Map keyed by externalId.
// mut.gg's overall-prices endpoint accepts comma-separated `external_ids`. We chunk into
// groups of 25 to keep URL length sane.
async function fetchOverallPricesBatch(externalIds) {
  const out = new Map();
  if (!externalIds.length) return out;
  const CHUNK = 25;
  const groups = [];
  for (let i = 0; i < externalIds.length; i += CHUNK) groups.push(externalIds.slice(i, i + CHUNK));
  await Promise.all(groups.map(async ids => {
    try {
      const j = await fetchJson(`${MUTGG}/api/mutdb/prices/overall/playeritem/?external_ids=${ids.join(',')}`);
      for (const entry of (j.data || [])) {
        if (entry.externalId != null) out.set(entry.externalId, entry);
      }
    } catch {/* swallow — median is non-critical */}
  }));
  return out;
}

// mut.gg's JSON API (/api/mutdb/player-items/) has a pagination bug: when range
// filters like overall__gte/overall__lte are passed, every `page=N` returns the
// same first 10 records (verified 2026-05-30). totalCount lies about retrievability.
//
// Their server-side rendered /players/ HTML pages DO paginate correctly. So we
// scrape those instead. Each tile contains:
//   - data-external-id="<id>"
//   - player-list-item__score-value">  N  </ (OVR)
//   - player-list-item__name-first">F</  /  __name-last">L</
//   - player-list-item__program">Program Name</
//   - player-list-item__archetype">Position - Archetype</
//
// The `market=` URL param maps platform: 1=Xbox Series X, 2=PS5, 3=PC. Without it,
// the page renders blank prices but the metadata is the same; we still need it for
// consistency with the user's chosen platform context.
const MARKET_BY_PLATFORM = {
  'pc':              '3',
  'xbox-series-x':   '1',
  'playstation-5':   '2',
};

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parsePlayerTiles(html) {
  const tiles = [];
  const tileRe = /<div class="player-list-item">([\s\S]*?)(?=<div class="player-list-item">|<\/main>|<\/section>|$)/g;
  let m;
  while ((m = tileRe.exec(html))) {
    const body = m[1];
    const idMatch     = body.match(/data-external-id="(\d+)"/);
    const urlMatch    = body.match(/href="(\/players\/[^"]+\/26-\d+\/)"/);
    const ovrMatch    = body.match(/player-list-item__score-value">\s*(\d+)/);
    const firstMatch  = body.match(/player-list-item__name-first">\s*([^<]+?)\s*</);
    const lastMatch   = body.match(/player-list-item__name-last\s*">\s*([^<]+?)\s*</);
    const progMatch   = body.match(/player-list-item__program[^>]*>\s*([^<]+?)\s*</);
    const archMatch   = body.match(/player-list-item__archetype[^>]*>\s*([^<]+?)\s*</);
    if (!idMatch || !ovrMatch) continue;
    tiles.push({
      externalId: Number(idMatch[1]),
      gameSlug:   '26',
      url:        urlMatch ? urlMatch[1] : null,
      ovr:        Number(ovrMatch[1]),
      name:       decodeEntities((firstMatch?.[1] || '') + ' ' + (lastMatch?.[1] || '')).trim(),
      program:    progMatch ? decodeEntities(progMatch[1]) : '?',
      archetype:  archMatch ? decodeEntities(archMatch[1]).replace(/\s+/g, ' ').trim() : '',
    });
  }
  return tiles;
}

// Paginate mut.gg's HTML /players/ index and collect all auctionable cards in the
// given OVR range. Optional narrowing:
//   - programFilter: substring match on program name (include only)
//   - excludePrograms: exact-name list of programs to skip entirely
//   - excludeExternalIds: list of specific card externalIds to skip
async function discoverCandidates({ overallMin, overallMax, platform, programFilter, excludePrograms, excludeExternalIds }) {
  const market = MARKET_BY_PLATFORM[platform] || '3';
  const baseQS = `overall__gte=${overallMin}&overall__lte=${overallMax}&market=${market}`;
  const all = [];
  const seen = new Set();
  const MAX_PAGES = 60;  // safety cap; 471 cards @ 15/page = 32 pages, so 60 has headroom
  for (let page = 1; page <= MAX_PAGES; page++) {
    let html;
    try {
      const r = await fetch(`${MUTGG}/players/?${baseQS}&page=${page}`, {
        headers: BROWSER_HEADERS,
      });
      if (!r.ok) break;
      html = await r.text();
    } catch { break; }
    const tiles = parsePlayerTiles(html);
    if (!tiles.length) break;  // past last page
    let newOnPage = 0;
    for (const t of tiles) {
      if (seen.has(t.externalId)) continue;
      seen.add(t.externalId);
      all.push(t);
      newOnPage++;
    }
    if (newOnPage === 0) break;  // page returned only dupes — past the end
  }

  // Filters: programFilter (substring include), excludePrograms (exact-name exclude
  // list, case-insensitive), excludeExternalIds (specific card ids to skip)
  const pf = (programFilter || '').toLowerCase().trim();
  const excludeProg = new Set((excludePrograms || []).map(p => p.toLowerCase()));
  const excludeIds  = new Set((excludeExternalIds || []).map(Number));
  return all.filter(c => {
    if (excludeIds.has(c.externalId)) return false;
    const prog = (c.program || '').toLowerCase();
    if (pf && !prog.includes(pf)) return false;
    if (excludeProg.has(prog)) return false;
    return true;
  });
}

// Effective target price for a watch given its current median. Supports two modes:
//   - absolute (default): targetBin is a fixed coin price
//   - percent: alert when BIN ≤ median × (1 - targetPercent/100). e.g. percent=30
//     means "alert when BIN is at least 30% under the card's median price".
function effectiveTarget(watch, med) {
  if (watch.targetMode === 'percent' && watch.targetPercent != null && med != null) {
    return Math.floor(med * (1 - watch.targetPercent / 100));
  }
  return watch.targetBin;
}

// ---------- KV ----------

async function loadWatches(env) {
  const raw = await env.WATCHES.get('watches');
  return raw ? JSON.parse(raw) : {};
}
async function saveWatches(env, watches) {
  await env.WATCHES.put('watches', JSON.stringify(watches));
}

// Filter-watch state: candidate card list, and per-candidate last-alerted price.
// Candidates are stored without expiration; refresh is explicit via API or auto
// when a candidate poll cycle wraps (see pollFilterWatch).
async function loadCandidates(env, watchId) {
  const raw = await env.WATCHES.get(`candidates:${watchId}`);
  return raw ? JSON.parse(raw) : null;
}
async function saveCandidates(env, watchId, list) {
  await env.WATCHES.put(`candidates:${watchId}`, JSON.stringify(list));
}

// One KV entry per (filter watch, candidate). Stores the last price we alerted on.
// Cleared when the candidate goes off-market so re-listings can re-arm.
async function loadLastAlerted(env, watchId, externalId) {
  const raw = await env.WATCHES.get(`la:${watchId}:${externalId}`);
  return raw ? Number(raw) : null;
}
async function saveLastAlerted(env, watchId, externalId, price) {
  await env.WATCHES.put(`la:${watchId}:${externalId}`, String(price));
}
async function clearLastAlerted(env, watchId, externalId) {
  await env.WATCHES.delete(`la:${watchId}:${externalId}`);
}

// ---------- Discord ----------

async function postDiscord(webhook, { title, body, url, color = 0x1f5b3a, fields = [] }) {
  const payload = {
    embeds: [{
      title,
      description: body,
      url: url || undefined,
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'mut.gg auction alerts' },
    }],
  };
  const r = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.ok || r.status === 204;
}

// ---------- cron: poll & alert ----------

// Filter-watch poll tuning.
// Bursting (100 in parallel) gets us 429'd; sustained low rate doesn't. With
// concurrency=5 and chunk=100, we spread 100 requests over ~20 sec at ~5 req/sec
// sustained — well below mut.gg's threshold. Sweep wall-clock for 400 candidates
// drops to ~4 min vs. ~16 min at the previous 25/tick.
const FILTER_CHUNK_SIZE = 100;
const FILTER_CONCURRENCY = 5;

async function pollCardWatches(env, watches, ids, webhook) {
  const results = [];
  // Dedupe fetches: multiple card watches can share (gameSlug, externalId, platform).
  const keyOf = w => `${w.gameSlug}|${w.externalId}|${w.platform}`;
  const uniqueKeys = [...new Set(ids.map(id => keyOf(watches[id])))];
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

  // Batch-fetch medians for all unique externalIds in one or two API hits.
  const uniqueExternalIds = [...new Set(ids.map(id => watches[id].externalId))];
  const medianByExternalId = await fetchOverallPricesBatch(uniqueExternalIds);

  for (const id of ids) {
    const w = watches[id];
    const fetched = liveByKey.get(keyOf(w));
    if (fetched.error) {
      w.lastError = fetched.error;
      w.lastChecked = Date.now();
      results.push({ id, name: w.name, error: w.lastError });
      continue;
    }
    const { liveAuctions } = fetched;
    const med = medianByExternalId.get(w.externalId)?.price?.[w.platform] ?? null;

    // Cache snapshot data on the watch so the UI doesn't need its own mut.gg fetch.
    const allCheapest = liveAuctions.reduce(
      (m, a) => a.buyNowPrice != null && (m == null || a.buyNowPrice < m) ? a.buyNowPrice : m,
      null
    );
    w.cachedCheapestBin = allCheapest;
    w.cachedMed = med;
    w.cachedSnapshotAt = Date.now();

    // Effective target accounts for absolute vs percent-of-median modes.
    const target = effectiveTarget(w, med);
    const matches = liveAuctions.filter(a =>
      a.buyNowPrice != null && (target == null || a.buyNowPrice <= target)
    );
    const cheapest = matches.reduce(
      (m, a) => (m == null || a.buyNowPrice < m.buyNowPrice) ? a : m,
      null
    );
    // Strict-decrease rule: once we've alerted at a given price, never re-alert
    // at the same price (or higher) — even if the card goes off-market and
    // re-lists later. Only a strictly cheaper listing fires a new alert.
    const beatsPrior = cheapest && (w.lastAlertedPrice == null || cheapest.buyNowPrice < w.lastAlertedPrice);
    let fired = 0;
    if (beatsPrior) {
      const targetLabel = w.targetMode === 'percent'
        ? `≤ ${w.targetPercent}% under median (${fmt(target)})`
        : fmt(w.targetBin);
      await postDiscord(webhook, {
        title: `🎯 ${w.name} (${w.program}) — ${PLATFORMS[w.platform] || w.platform}`,
        body: `**BIN ${fmt(cheapest.buyNowPrice)}** · target ${targetLabel}${med != null ? ` · median ${fmt(med)}` : ''}\nCurrent bid ${fmt(cheapest.currentBid ?? cheapest.startingBid)} · ends <t:${Math.floor(new Date(cheapest.endDate).getTime()/1000)}:R>${matches.length > 1 ? `\n*+${matches.length - 1} other listing(s) below target*` : ''}`,
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
    results.push({ id, name: w.name, matches: matches.length, cheapest: cheapest?.buyNowPrice ?? null, fired });
  }
  return { results, uniqueFetches: uniqueKeys.length };
}

async function pollFilterWatch(env, watch, webhook) {
  // Load the cached candidate list; if missing, skip this tick (UI / API will rediscover).
  const candidates = await loadCandidates(env, watch.id);
  if (!candidates || candidates.length === 0) {
    watch.lastError = 'no candidates cached — refresh via /api/watches/:id/refresh';
    watch.lastChecked = Date.now();
    return { id: watch.id, skipped: 'no candidates' };
  }

  // Take the next chunk starting from the cursor; wrap around if we hit the end.
  const start = (watch.cursor || 0) % candidates.length;
  const end   = Math.min(start + FILTER_CHUNK_SIZE, candidates.length);
  const chunk = candidates.slice(start, end);
  const nextCursor = end >= candidates.length ? 0 : end;

  // Batch-fetch medians for the chunk (one request per 25-id group) so each
  // candidate's percent-of-median target can be computed correctly.
  const medianByExternalId = watch.targetMode === 'percent'
    ? await fetchOverallPricesBatch(chunk.map(c => c.externalId))
    : new Map();

  let fired = 0;
  const failures = [];
  await mapWithConcurrency(chunk, FILTER_CONCURRENCY, async cand => {
    let liveAuctions;
    try {
      ({ liveAuctions } = await fetchLiveAuctions(cand.gameSlug, cand.externalId, watch.platform));
    } catch (e) {
      failures.push(`${cand.name}: ${e.message}`);
      return;
    }
    const med = medianByExternalId.get(cand.externalId)?.price?.[watch.platform] ?? null;
    const target = effectiveTarget(watch, med);
    // If percent-of-median is requested but we have no median, skip this candidate
    // (otherwise we'd fall back to targetBin which may be wrong/unset).
    if (watch.targetMode === 'percent' && target == null) return;

    const matches = liveAuctions.filter(a => a.buyNowPrice != null && a.buyNowPrice <= target);
    const cheapest = matches.reduce(
      (m, a) => (m == null || a.buyNowPrice < m.buyNowPrice) ? a : m,
      null
    );
    const prior = await loadLastAlerted(env, watch.id, cand.externalId);

    // Strict-decrease rule: only fire if the cheapest currently-live BIN is
    // strictly less than our last alerted price for this candidate. No re-arm
    // on off-market: if we've already alerted at 2.6M, never alert at 2.6M again
    // even after the card disappears and re-lists.
    const beats = cheapest && (prior == null || cheapest.buyNowPrice < prior);
    if (!beats) return;

    const targetLabel = watch.targetMode === 'percent'
      ? `≤ ${watch.targetPercent}% under median (${fmt(target)})`
      : fmt(target);
    await postDiscord(webhook, {
      title: `🎯 ${cand.name} (${cand.program}) ${cand.ovr} OVR — ${PLATFORMS[watch.platform] || watch.platform}`,
      body: `**BIN ${fmt(cheapest.buyNowPrice)}** · target ${targetLabel}${med != null ? ` · median ${fmt(med)}` : ''}\nFilter \`${watch.overallMin}-${watch.overallMax} OVR${watch.programFilter ? ' · ' + watch.programFilter : ''}\` · ends <t:${Math.floor(new Date(cheapest.endDate).getTime()/1000)}:R>${matches.length > 1 ? `\n*+${matches.length - 1} other listing(s) below target*` : ''}`,
      url: `${MUTGG}${cand.url}#prices`,
      color: 0xF5C518,
      fields: [
        { name: 'Bids',  value: String(cheapest.bidCount ?? 0), inline: true },
        { name: 'Recur', value: watch.recurring ? 'Yes' : 'No', inline: true },
      ],
    });
    await saveLastAlerted(env, watch.id, cand.externalId, cheapest.buyNowPrice);
    fired++;
    watch.lastAlertedAt = Date.now();
    watch.lastAlertedName = cand.name;
    watch.lastAlertedPrice = cheapest.buyNowPrice;
  });

  watch.cursor = nextCursor;
  watch.lastChecked = Date.now();
  watch.lastError = failures.length ? failures.slice(0, 2).join('; ') + (failures.length > 2 ? ` (+${failures.length - 2} more)` : '') : null;
  return {
    id: watch.id,
    kind: 'filter',
    chunkStart: start,
    chunkSize: chunk.length,
    fired,
    failures: failures.length,
    candidateCount: candidates.length,
  };
}

// Fields that the polling loop updates on a watch. When we merge poll output back
// into KV, ONLY these fields override the latest stored state — everything else
// (target price, recurring, the watch's existence itself) reflects user edits
// that may have happened during the long-running poll.
const POLL_MANAGED_FIELDS = [
  'lastChecked', 'lastError',
  'lastAlertedAt', 'lastAlertedPrice', 'lastAlertedName',
  'cursor',
  'cachedCheapestBin', 'cachedMed', 'cachedSnapshotAt',
];

async function pollOnce(env) {
  const webhook = env.DISCORD_WEBHOOK;
  if (!webhook) return { skipped: 'no DISCORD_WEBHOOK secret' };

  const watches = await loadWatches(env);
  const allIds = Object.keys(watches);
  const cardIds   = allIds.filter(id => (watches[id].kind || 'card') === 'card');
  const filterIds = allIds.filter(id => watches[id].kind === 'filter');

  const cardResult = cardIds.length
    ? await pollCardWatches(env, watches, cardIds, webhook)
    : { results: [], uniqueFetches: 0 };

  const filterResults = [];
  for (const id of filterIds) {
    filterResults.push(await pollFilterWatch(env, watches[id], webhook));
  }

  // Concurrency-safe save: re-read the latest KV state and only overlay our
  // poll-managed fields onto watches that still exist. This way a user delete
  // (or target edit) that happened during this poll is preserved.
  const fresh = await loadWatches(env);
  for (const id of Object.keys(fresh)) {
    const ours = watches[id];
    if (!ours) continue;  // watch added by user during our poll — leave their version alone
    for (const f of POLL_MANAGED_FIELDS) {
      if (f in ours) fresh[id][f] = ours[f];
    }
  }
  await saveWatches(env, fresh);

  return {
    polled: allIds.length,
    cards: cardResult.results,
    filters: filterResults,
    uniqueCardFetches: cardResult.uniqueFetches,
  };
}

// ---------- HTTP API ----------

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function unauthorized() { return jsonResponse({ error: 'unauthorized' }, { status: 401 }); }

function checkAuth(req, env) {
  const provided = req.headers.get('X-Auth') || new URL(req.url).searchParams.get('auth');
  return env.AUTH_SECRET && provided === env.AUTH_SECRET;
}

async function handleApi(req, env, url) {
  if (!checkAuth(req, env)) return unauthorized();
  const path = url.pathname;

  // List watches with last-poll metadata + current BIN/MED snapshot
  if (req.method === 'GET' && path === '/api/watches') {
    const watches = await loadWatches(env);
    return jsonResponse({ watches });
  }

  // Add or update a watch (card watch — by externalId+platform).
  if (req.method === 'POST' && path === '/api/watches') {
    const body = await req.json();
    const { externalId, gameSlug, url: playerUrl, name, program, ovr, platform, targetBin, recurring } = body;
    if (!externalId || !platform) return jsonResponse({ error: 'missing externalId or platform' }, { status: 400 });
    const targetMode    = body.targetMode === 'percent' ? 'percent' : 'absolute';
    const targetPercent = body.targetPercent == null ? null : Number(body.targetPercent);
    const id = `${externalId}-${platform}`;
    const watches = await loadWatches(env);
    watches[id] = {
      id, kind: 'card',
      externalId, gameSlug: gameSlug || '26', url: playerUrl, name, program, ovr,
      platform,
      targetMode,
      targetBin:     targetBin == null ? null : Number(targetBin),
      targetPercent: Number.isFinite(targetPercent) ? targetPercent : null,
      recurring: !!recurring,
      lastChecked: watches[id]?.lastChecked || 0,
      lastError:   null,
      lastAlertedAt: watches[id]?.lastAlertedAt || null,
      lastAlertedPrice: watches[id]?.lastAlertedPrice || null,
      cachedCheapestBin: watches[id]?.cachedCheapestBin ?? null,
      cachedMed:         watches[id]?.cachedMed ?? null,
      cachedSnapshotAt:  watches[id]?.cachedSnapshotAt ?? null,
    };
    await saveWatches(env, watches);
    return jsonResponse({ ok: true, watch: watches[id] });
  }

  // Create a filter watch (OVR range across all matching cards).
  // Discovery is synchronous so the user knows immediately how many candidates exist.
  // PARTIAL-UPDATE SEMANTICS: when an existing watch is being edited (e.g. target
  // change), fields NOT present in the request body are preserved from the existing
  // record. This prevents the UI form (which has no input for excludeExternalIds)
  // from wiping out per-card exclusions every time the user tweaks a target.
  if (req.method === 'POST' && path === '/api/watches/filter') {
    const body = await req.json();
    const overallMin = Number(body.overallMin);
    const overallMax = Number(body.overallMax);
    const platform   = body.platform;

    // We can't look up the existing watch yet (we don't have its id), so compute id
    // and load watches FIRST, then merge.
    if (!Number.isFinite(overallMin) || !Number.isFinite(overallMax) || overallMin > overallMax) {
      return jsonResponse({ error: 'invalid overallMin/overallMax' }, { status: 400 });
    }
    if (!platform) return jsonResponse({ error: 'missing platform' }, { status: 400 });

    const watches = await loadWatches(env);
    // We need programFilter to compute the id. If absent in body, fall back to nothing
    // — we'll re-key from the existing watch found below if the user is editing.
    const bodyProgramFilter = 'programFilter' in body ? String(body.programFilter || '').trim() : null;
    const tentativeProgramSlug = bodyProgramFilter
      ? '-' + bodyProgramFilter.replace(/\W+/g, '_').toLowerCase()
      : '';
    const tentativeId = `filter-${overallMin}-${overallMax}-${platform}${tentativeProgramSlug}`;
    // If the user is editing an existing watch by passing programFilter explicitly,
    // tentativeId might point to a DIFFERENT existing watch (or none). For now we trust
    // the tentativeId — the recurring-toggle path passes the watch's existing fields back.
    const existing = watches[tentativeId];

    // PRESERVE: each field falls back to the existing watch's value if the body omits it.
    const targetMode    = body.targetMode === 'percent' ? 'percent'
                         : body.targetMode === 'absolute' ? 'absolute'
                         : (existing?.targetMode || 'absolute');
    const targetBin     = 'targetBin'     in body && body.targetBin     != null ? Number(body.targetBin)     : (existing?.targetBin     ?? null);
    const targetPercent = 'targetPercent' in body && body.targetPercent != null ? Number(body.targetPercent) : (existing?.targetPercent ?? null);

    const programFilter = bodyProgramFilter != null ? bodyProgramFilter : (existing?.programFilter || '');

    function parseList(v, isNum) {
      if (typeof v === 'string') return v.split(isNum ? /[,\s]+/ : ',').map(s => isNum ? Number(s) : s.trim()).filter(Boolean).filter(x => !isNum || Number.isFinite(x));
      if (Array.isArray(v)) return v.map(x => isNum ? Number(x) : x).filter(x => !isNum || Number.isFinite(x));
      return null;
    }
    const bodyExcludePrograms    = 'excludePrograms'    in body ? parseList(body.excludePrograms,    false) : null;
    const bodyExcludeExternalIds = 'excludeExternalIds' in body ? parseList(body.excludeExternalIds,  true) : null;
    const excludePrograms    = bodyExcludePrograms    || existing?.excludePrograms    || [];
    const excludeExternalIds = bodyExcludeExternalIds || existing?.excludeExternalIds || [];

    const recurring = 'recurring' in body ? !!body.recurring : (existing?.recurring ?? true);

    if (targetMode === 'absolute' && !Number.isFinite(targetBin)) {
      return jsonResponse({ error: 'missing targetBin' }, { status: 400 });
    }
    if (targetMode === 'percent' && !Number.isFinite(targetPercent)) {
      return jsonResponse({ error: 'missing targetPercent' }, { status: 400 });
    }
    if (!Number.isFinite(overallMin) || !Number.isFinite(overallMax) || overallMin > overallMax) {
      return jsonResponse({ error: 'invalid overallMin/overallMax' }, { status: 400 });
    }
    const id = tentativeId;
    const candidates = await discoverCandidates({ overallMin, overallMax, platform, programFilter, excludePrograms, excludeExternalIds });
    await saveCandidates(env, id, candidates);

    watches[id] = {
      id, kind: 'filter',
      overallMin, overallMax, platform,
      programFilter,
      excludePrograms,
      excludeExternalIds,
      targetMode,
      targetBin:     Number.isFinite(targetBin)     ? targetBin     : null,
      targetPercent: Number.isFinite(targetPercent) ? targetPercent : null,
      recurring,
      candidateCount: candidates.length,
      candidatesUpdatedAt: Date.now(),
      cursor: 0,
      lastChecked: existing?.lastChecked || 0,
      lastError: null,
      lastAlertedAt: existing?.lastAlertedAt || null,
      lastAlertedName: existing?.lastAlertedName || null,
      lastAlertedPrice: existing?.lastAlertedPrice || null,
    };
    await saveWatches(env, watches);
    return jsonResponse({ ok: true, watch: watches[id] });
  }

  // Update only the exclusion lists on a filter watch (without re-supplying full config).
  // Body: { excludePrograms?, excludeExternalIds? }. Either string CSV or array.
  // Re-discovers candidates synchronously so the user sees the new count immediately.
  if (req.method === 'POST' && path.startsWith('/api/watches/') && path.endsWith('/exclusions')) {
    const id = decodeURIComponent(path.slice('/api/watches/'.length, -'/exclusions'.length));
    const body = await req.json();
    const watches = await loadWatches(env);
    const w = watches[id];
    if (!w || w.kind !== 'filter') return jsonResponse({ error: 'not a filter watch' }, { status: 404 });

    let excludePrograms = body.excludePrograms;
    if (typeof excludePrograms === 'string') excludePrograms = excludePrograms.split(',').map(s => s.trim()).filter(Boolean);
    if (Array.isArray(excludePrograms)) w.excludePrograms = excludePrograms;

    let excludeExternalIds = body.excludeExternalIds;
    if (typeof excludeExternalIds === 'string') excludeExternalIds = excludeExternalIds.split(/[,\s]+/).map(Number).filter(Number.isFinite);
    if (Array.isArray(excludeExternalIds)) w.excludeExternalIds = excludeExternalIds.map(Number).filter(Number.isFinite);

    const candidates = await discoverCandidates({
      overallMin: w.overallMin, overallMax: w.overallMax, platform: w.platform,
      programFilter: w.programFilter,
      excludePrograms: w.excludePrograms,
      excludeExternalIds: w.excludeExternalIds,
    });
    await saveCandidates(env, id, candidates);
    w.candidateCount = candidates.length;
    w.candidatesUpdatedAt = Date.now();
    w.cursor = 0;
    await saveWatches(env, watches);
    return jsonResponse({
      ok: true,
      candidateCount: candidates.length,
      excludePrograms: w.excludePrograms || [],
      excludeExternalIds: w.excludeExternalIds || [],
    });
  }

  // List the candidate cards currently being polled by a filter watch (post-filter view).
  // Returns the cached candidate list — what the cron actually polls.
  if (req.method === 'GET' && path.startsWith('/api/watches/') && path.endsWith('/candidates')) {
    const id = decodeURIComponent(path.slice('/api/watches/'.length, -'/candidates'.length));
    const watches = await loadWatches(env);
    const w = watches[id];
    if (!w || w.kind !== 'filter') return jsonResponse({ error: 'not a filter watch' }, { status: 404 });
    const candidates = await loadCandidates(env, id) || [];
    return jsonResponse({
      candidates,
      excludePrograms:    w.excludePrograms || [],
      excludeExternalIds: w.excludeExternalIds || [],
      watch: {
        overallMin: w.overallMin, overallMax: w.overallMax, platform: w.platform,
        programFilter: w.programFilter, recurring: w.recurring,
      },
    });
  }

  // List ALL candidates that would match the watch's discovery query if NO exclusions
  // were applied — useful for the picker page (shows everything, lets user toggle).
  if (req.method === 'GET' && path.startsWith('/api/watches/') && path.endsWith('/all-candidates')) {
    const id = decodeURIComponent(path.slice('/api/watches/'.length, -'/all-candidates'.length));
    const watches = await loadWatches(env);
    const w = watches[id];
    if (!w || w.kind !== 'filter') return jsonResponse({ error: 'not a filter watch' }, { status: 404 });
    const candidates = await discoverCandidates({
      overallMin: w.overallMin, overallMax: w.overallMax, platform: w.platform,
      programFilter: w.programFilter,
    });
    return jsonResponse({
      candidates,
      excludePrograms:    w.excludePrograms || [],
      excludeExternalIds: w.excludeExternalIds || [],
      watch: {
        overallMin: w.overallMin, overallMax: w.overallMax, platform: w.platform,
        programFilter: w.programFilter, recurring: w.recurring,
      },
    });
  }

  // Manually re-discover candidates for a filter watch (e.g., after new content drops).
  if (req.method === 'POST' && path.startsWith('/api/watches/') && path.endsWith('/refresh')) {
    const id = decodeURIComponent(path.slice('/api/watches/'.length, -'/refresh'.length));
    const watches = await loadWatches(env);
    const w = watches[id];
    if (!w || w.kind !== 'filter') return jsonResponse({ error: 'not a filter watch' }, { status: 404 });
    const candidates = await discoverCandidates({
      overallMin: w.overallMin, overallMax: w.overallMax, platform: w.platform,
      programFilter: w.programFilter,
      excludePrograms: w.excludePrograms,
      excludeExternalIds: w.excludeExternalIds,
    });
    await saveCandidates(env, id, candidates);
    w.candidateCount = candidates.length;
    w.candidatesUpdatedAt = Date.now();
    w.cursor = 0;
    await saveWatches(env, watches);
    return jsonResponse({ ok: true, candidateCount: candidates.length });
  }

  // Delete a watch (card or filter). Also clears any per-candidate alert state.
  if (req.method === 'DELETE' && path.startsWith('/api/watches/')) {
    const id = decodeURIComponent(path.slice('/api/watches/'.length));
    const watches = await loadWatches(env);
    const wasFilter = watches[id]?.kind === 'filter';
    delete watches[id];
    await saveWatches(env, watches);
    await env.WATCHES.delete(`seen:${id}`);
    if (wasFilter) {
      await env.WATCHES.delete(`candidates:${id}`);
      // Clear all per-candidate lastAlerted entries for this filter watch.
      let cursor;
      do {
        const list = await env.WATCHES.list({ prefix: `la:${id}:`, cursor });
        await Promise.all(list.keys.map(k => env.WATCHES.delete(k.name)));
        cursor = list.list_complete ? null : list.cursor;
      } while (cursor);
    }
    return jsonResponse({ ok: true });
  }

  // Player search → returns auctionable cards for the surname provided
  if (req.method === 'GET' && path === '/api/search') {
    const name = url.searchParams.get('name') || '';
    if (!name) return jsonResponse({ data: [] });
    const data = await searchPlayer(name);
    return jsonResponse({ data });
  }

  // Snapshot prices for one card (used to render BIN/MED on the alert log).
  // Serves from the cached values stored on the watch by the cron poll when fresh,
  // falling back to a live fetch only if the cache is stale (or missing).
  if (req.method === 'GET' && path === '/api/snapshot') {
    const externalId = url.searchParams.get('externalId');
    const platform   = url.searchParams.get('platform');
    const gameSlug   = url.searchParams.get('gameSlug') || '26';
    if (!externalId || !platform) return jsonResponse({ error: 'missing externalId/platform' }, { status: 400 });

    // Try cache first (~3 min freshness window — cron polls every minute).
    const watches = await loadWatches(env);
    const cached = watches[`${externalId}-${platform}`];
    if (cached && cached.cachedSnapshotAt && Date.now() - cached.cachedSnapshotAt < 180_000) {
      return jsonResponse({
        cheapestBin: cached.cachedCheapestBin ?? null,
        med:         cached.cachedMed ?? null,
        cached:      true,
        ageMs:       Date.now() - cached.cachedSnapshotAt,
      });
    }

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
  }

  // Test Discord webhook
  if (req.method === 'POST' && path === '/api/test') {
    if (!env.DISCORD_WEBHOOK) return jsonResponse({ error: 'no DISCORD_WEBHOOK secret set' }, { status: 400 });
    const ok = await postDiscord(env.DISCORD_WEBHOOK, {
      title: '🧪 Test alert',
      body: 'If you see this in Discord, your webhook is wired correctly.',
      color: 0x5865F2,
    });
    return jsonResponse({ ok });
  }

  // Manual poll (useful for testing without waiting for cron)
  if (req.method === 'POST' && path === '/api/poll') {
    const r = await pollOnce(env);
    return jsonResponse(r);
  }

  // One-shot cleanup of orphaned `seen:*` KV keys left behind by the old
  // per-listing fingerprint dedup model. Safe to re-run; no-op once empty.
  if (req.method === 'POST' && path === '/api/cleanup-seen') {
    let deleted = 0;
    let cursor;
    do {
      const list = await env.WATCHES.list({ prefix: 'seen:', cursor });
      await Promise.all(list.keys.map(k => env.WATCHES.delete(k.name)));
      deleted += list.keys.length;
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor);
    return jsonResponse({ ok: true, deleted });
  }

  return jsonResponse({ error: 'not found' }, { status: 404 });
}

// ---------- daily candidate refresh ----------

// Re-discovers candidate cards for every filter watch. Runs on its own daily cron
// (08:00 UTC) so new program drops automatically get covered without the user
// having to remember to click the ↻ refresh button.
async function refreshAllFilterCandidates(env) {
  const watches = await loadWatches(env);
  const filterIds = Object.keys(watches).filter(id => watches[id].kind === 'filter');
  if (filterIds.length === 0) return { refreshed: 0 };

  const updates = {};   // { id: { candidateCount, candidatesUpdatedAt, cursor } }
  for (const id of filterIds) {
    const w = watches[id];
    try {
      const candidates = await discoverCandidates({
        overallMin: w.overallMin, overallMax: w.overallMax, platform: w.platform,
        programFilter: w.programFilter,
        excludePrograms: w.excludePrograms,
        excludeExternalIds: w.excludeExternalIds,
      });
      await saveCandidates(env, id, candidates);
      updates[id] = {
        candidateCount: candidates.length,
        candidatesUpdatedAt: Date.now(),
        // Don't reset cursor on auto-refresh — keep the rotation going from where
        // it left off, just wrap if it now points past the new end.
        cursor: w.cursor != null && w.cursor < candidates.length ? w.cursor : 0,
      };
    } catch (e) {
      updates[id] = { lastError: `auto-refresh failed: ${e.message}` };
    }
  }

  // Concurrency-safe merge (same pattern as pollOnce): re-read latest KV state and
  // only overlay our refresh-managed fields on watches that still exist.
  const fresh = await loadWatches(env);
  for (const id of Object.keys(updates)) {
    if (!fresh[id]) continue;  // user deleted it during refresh
    Object.assign(fresh[id], updates[id]);
  }
  await saveWatches(env, fresh);
  return { refreshed: filterIds.length };
}

// ---------- worker entrypoints ----------

export default {
  async scheduled(event, env, ctx) {
    // Multiple cron schedules — dispatch by event.cron string.
    if (event.cron === '0 8 * * *') {
      ctx.waitUntil(refreshAllFilterCandidates(env));
    } else {
      // Default: the per-minute poll loop.
      ctx.waitUntil(pollOnce(env));
    }
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, url);
    if (url.pathname.startsWith('/manage/')) {
      return new Response(MANAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    // Everything else: serve the UI shell. UI handles auth client-side via prompt.
    return new Response(UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
};

// ---------- embedded UI ----------

const UI_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MUT.GG Auction Alerts</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background:#0b0f12; color:#e7e9ea; font:14px/1.45 system-ui,sans-serif; margin:0; padding:24px; max-width:920px; margin-inline:auto; }
h1 { font-size:20px; margin:0 0 4px; letter-spacing:.3px; }
.lede { color:#9aa3ad; margin:0 0 24px; font-size:13px; }
.card { background:#11161a; border:1px solid #232b33; border-radius:10px; padding:14px 16px; margin-bottom:14px; }
.row { display:flex; gap:8px; }
.grow { flex:1; min-width:0; }
label { display:block; color:#9aa3ad; font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
input, select, button { background:#1a2229; color:#e7e9ea; border:1px solid #2a3540; border-radius:6px; padding:8px 10px; font:inherit; width:100%; }
button { cursor:pointer; width:auto; }
button.primary { background:#1f5b3a; border-color:#2a7a4d; font-weight:600; }
button.primary:hover { background:#2a7a4d; }
button.danger { background:#5b1f1f; border-color:#7a2a2a; }
button.pill { border-radius:999px; padding:6px 14px; font-size:11px; text-transform:uppercase; letter-spacing:.6px; font-weight:600; }
button.pill.on { background:#1f5b3a; border-color:#2a7a4d; color:#7ed996; }
button.pill.off { background:#1a2229; color:#9aa3ad; }
button.tab { background:#1a2229; color:#9aa3ad; border:1px solid #2a3540; border-radius:6px; padding:6px 12px; font-size:12px; font-weight:600; }
button.tab.on { background:#1a2229; color:#e7e9ea; border-color:#3FA9F5; }
.alert {
  display:grid; grid-template-columns:auto 1fr auto; gap:14px; align-items:center;
  background:#11161a; border:1px solid #232b33; border-radius:10px; padding:14px 16px; margin-bottom:10px;
}
.ovr { font:italic 700 22px/1 system-ui,sans-serif; padding:6px 10px; }
.alert .meta-name { font:italic 700 16px system-ui,sans-serif; letter-spacing:.5px; }
.alert .pos { color:#9aa3ad; font-size:11px; margin-left:6px; }
.alert .sub { color:#9aa3ad; font-size:11px; margin-top:2px; text-transform:uppercase; letter-spacing:.5px; }
.prices { display:flex; gap:24px; margin-top:8px; }
.price { font-weight:600; }
.price .v { font-size:18px; }
.price .l { color:#9aa3ad; font-size:10px; text-transform:uppercase; letter-spacing:.6px; margin-top:1px; }
.price.bin .v   { color:#F5C518; }
.price.med .v   { color:#e7e9ea; }
.price.target .v{ color:#3FA9F5; }
.alerted-at { color:#9aa3ad; font-size:10px; margin-top:6px; text-transform:uppercase; letter-spacing:.5px; }
.actions { display:flex; flex-direction:column; gap:6px; align-items:flex-end; }
.iconbtn { width:34px; height:34px; border-radius:50%; padding:0; display:inline-flex; align-items:center; justify-content:center; }
.iconbtn.edit { background:#1e3a5a; border-color:#2f5680; color:#9ec5f5; }
.iconbtn.del  { background:#5b1f1f; border-color:#7a2a2a; color:#f59a9a; }
.status { color:#9aa3ad; font-size:12px; margin-top:6px; min-height:16px; }
.status.err { color:#ff8a8a; }
.status.ok  { color:#7ed996; }
.empty { color:#677079; font-size:13px; text-align:center; padding:24px; }
.spinner { display:inline-block; width:12px; height:12px; border:2px solid #2a3540; border-top-color:#7ed996; border-radius:50%; animation:spin 0.8s linear infinite; vertical-align:middle; }
@keyframes spin { to { transform:rotate(360deg); } }
.muted { color:#677079; font-size:11px; }
</style>
</head><body>
<h1>🔔 MUT.GG Auction Alerts</h1>
<p class="lede">Always-on. Polls mut.gg every minute. Pings Discord when BIN ≤ target.</p>

<div class="card">
  <div class="tabs" style="display:flex; gap:6px; margin-bottom:12px;">
    <button class="tab on" data-mode="card" type="button">Specific card</button>
    <button class="tab" data-mode="filter" type="button">OVR filter</button>
  </div>

  <!-- Card mode -->
  <div id="mode-card">
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
      <div style="flex:0 0 200px;">
        <label>Alert when…</label>
        <select id="f-mode">
          <option value="absolute">Below coin price</option>
          <option value="percent">% below median</option>
        </select>
      </div>
      <div id="f-target-wrap" style="flex:1;">
        <label>Target price (alert ≤)</label>
        <input id="f-target" type="number" placeholder="400000">
      </div>
      <div id="f-percent-wrap" style="flex:1; display:none;">
        <label>Discount % (alert ≤ median × (1 − %))</label>
        <input id="f-percent" type="number" min="1" max="99" placeholder="30">
      </div>
      <div style="display:flex; flex-direction:column;">
        <label>Recurring</label>
        <button id="f-recurring" class="pill on" type="button">Yes</button>
      </div>
    </div>
    <div class="row" style="margin-top:12px; justify-content:flex-end;">
      <button id="btn-add" class="primary">Add watch</button>
    </div>
  </div>

  <!-- Filter mode -->
  <div id="mode-filter" style="display:none;">
    <div class="row" style="gap:12px;">
      <div style="flex:1;">
        <label>OVR min</label>
        <input id="ff-min" type="number" min="0" max="99" placeholder="96">
      </div>
      <div style="flex:1;">
        <label>OVR max</label>
        <input id="ff-max" type="number" min="0" max="99" placeholder="97">
      </div>
      <div style="flex:1.2;">
        <label>Platform</label>
        <select id="ff-platform">
          <option value="pc">PC</option>
          <option value="xbox-series-x">Xbox Series X</option>
          <option value="playstation-5">PlayStation 5</option>
        </select>
      </div>
    </div>
    <div class="row" style="gap:12px; margin-top:10px;">
      <div style="flex:2;">
        <label>Program filter (optional)</label>
        <input id="ff-program" placeholder="e.g. Sugar Rush — only watch this program" autocomplete="off">
      </div>
      <div style="display:flex; flex-direction:column;">
        <label>Recurring</label>
        <button id="ff-recurring" class="pill on" type="button">Yes</button>
      </div>
    </div>
    <div class="row" style="gap:12px; margin-top:10px;">
      <div style="flex:1;">
        <label>Exclude programs (optional, comma-separated)</label>
        <input id="ff-exclude" placeholder="e.g. Ultimate Legends, Tribute, TOTW" autocomplete="off">
      </div>
    </div>
    <div class="row" style="gap:12px; margin-top:10px;">
      <div style="flex:0 0 220px;">
        <label>Alert when…</label>
        <select id="ff-mode">
          <option value="absolute">BIN is below a coin price</option>
          <option value="percent">BIN is % below median</option>
        </select>
      </div>
      <div id="ff-target-wrap" style="flex:1;">
        <label>Target price (alert ≤)</label>
        <input id="ff-target" type="number" placeholder="125000">
      </div>
      <div id="ff-percent-wrap" style="flex:1; display:none;">
        <label>Discount % (alert ≤ median × (1 − %))</label>
        <input id="ff-percent" type="number" min="1" max="99" placeholder="30">
      </div>
    </div>
    <div class="muted" style="margin-top:8px;">
      Discovers every auctionable card in your OVR range (and program, if set), then polls in rotating chunks of 100 cards per minute. Full sweep for a typical range: ~4 minutes.
    </div>
    <div class="row" style="margin-top:12px; justify-content:flex-end;">
      <button id="btn-add-filter" class="primary">Add filter watch</button>
    </div>
  </div>

  <div id="add-status" class="status"></div>
</div>

<div style="display:flex; align-items:center; justify-content:space-between; margin:24px 0 10px;">
  <h2 style="font-size:14px; margin:0; text-transform:uppercase; letter-spacing:.7px; color:#9aa3ad;">Alert Log</h2>
  <div>
    <button id="btn-poll" type="button">Poll now</button>
    <button id="btn-test" type="button">Test Discord</button>
  </div>
</div>
<div id="log"></div>
<div id="log-status" class="status"></div>

<script>
const $ = s => document.querySelector(s);
const PLATFORMS = { 'pc':'PC', 'xbox-series-x':'Xbox Series X', 'playstation-5':'PlayStation 5' };
const fmt = n => n == null ? '—' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? Math.round(n/1e3)+'K' : ''+n;

function auth() {
  let s = localStorage.getItem('mutgg.auth');
  if (!s) { s = prompt('Enter AUTH_SECRET (set via wrangler):') || ''; if (s) localStorage.setItem('mutgg.auth', s); }
  return s;
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'X-Auth': auth(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { localStorage.removeItem('mutgg.auth'); throw new Error('unauthorized'); }
  return await r.json();
}

// Tab switching between Specific Card and OVR Filter add modes.
document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b === btn));
    const mode = btn.dataset.mode;
    $('#mode-card').style.display = mode === 'card' ? '' : 'none';
    $('#mode-filter').style.display = mode === 'filter' ? '' : 'none';
    $('#add-status').textContent = '';
  };
});

let searchRaw = [];    // all cards returned for the current name query (pre-OVR filter)
let searchCache = [];  // cards currently shown in dropdown (post-OVR filter); dropdown index = index here
let recurring = true;
$('#f-recurring').onclick = () => {
  recurring = !recurring;
  $('#f-recurring').classList.toggle('on', recurring);
  $('#f-recurring').classList.toggle('off', !recurring);
  $('#f-recurring').textContent = recurring ? 'Yes' : 'No';
};

let filterRecurring = true;
$('#ff-recurring').onclick = () => {
  filterRecurring = !filterRecurring;
  $('#ff-recurring').classList.toggle('on', filterRecurring);
  $('#ff-recurring').classList.toggle('off', !filterRecurring);
  $('#ff-recurring').textContent = filterRecurring ? 'Yes' : 'No';
};

// Toggle target-price vs percent-of-median input visibility on both forms.
function syncModeInputs(prefix) {
  const mode = $('#' + prefix + 'mode').value;
  $('#' + prefix + 'target-wrap').style.display  = mode === 'absolute' ? '' : 'none';
  $('#' + prefix + 'percent-wrap').style.display = mode === 'percent'  ? '' : 'none';
}
$('#f-mode').addEventListener('change',  () => syncModeInputs('f-'));
$('#ff-mode').addEventListener('change', () => syncModeInputs('ff-'));

function renderProgramDropdown() {
  const sel = $('#f-program');
  const ovrRaw = ($('#f-ovr').value || '').trim();
  const ovrFilter = ovrRaw === '' ? null : parseInt(ovrRaw, 10);
  const filtered = Number.isFinite(ovrFilter)
    ? searchRaw.filter(p => p.overall === ovrFilter)
    : searchRaw;
  searchCache = filtered;
  if (searchRaw.length === 0) {
    sel.innerHTML = '<option value="">— search a player first —</option>';
    return;
  }
  if (filtered.length === 0) {
    sel.innerHTML = '<option value="">— no ' + ovrFilter + ' OVR matches —</option>';
    return;
  }
  sel.innerHTML = filtered.map((p, i) =>
    '<option value="' + i + '">' + p.overall + ' OVR · ' + p.program?.name + ' · ' + p.firstName + ' ' + p.lastName + '</option>'
  ).join('');
}

let searchTimer;
$('#f-name').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const name = $('#f-name').value.trim();
  const sel = $('#f-program');
  sel.innerHTML = '<option value="">— typing… —</option>';
  if (!name) { searchRaw = []; searchCache = []; sel.innerHTML = '<option value="">— search a player first —</option>'; return; }
  searchTimer = setTimeout(async () => {
    try {
      const { data } = await api('/api/search?name=' + encodeURIComponent(name));
      const wantFirst = name.trim().split(/\\s+/).slice(0,-1).join(' ').toLowerCase();
      const wantLast  = name.trim().split(/\\s+/).pop().toLowerCase();
      searchRaw = data.filter(p => p.lastName.toLowerCase() === wantLast && (!wantFirst || p.firstName.toLowerCase().startsWith(wantFirst)));
      if (searchRaw.length === 0) { searchCache = []; sel.innerHTML = '<option value="">— no auctionable matches —</option>'; return; }
      renderProgramDropdown();
    } catch (e) { searchRaw = []; searchCache = []; sel.innerHTML = '<option value="">— error: ' + e.message + ' —</option>'; }
  }, 300);
});

$('#f-ovr').addEventListener('input', renderProgramDropdown);

$('#btn-add').onclick = async () => {
  const idx = $('#f-program').value;
  const mode = $('#f-mode').value;
  const target  = parseInt(($('#f-target').value  || '').replace(/[^\\d]/g,''), 10);
  const percent = parseInt(($('#f-percent').value || '').replace(/[^\\d]/g,''), 10);
  const status = $('#add-status'); status.className = 'status'; status.textContent = '';
  if (!searchCache[idx]) { status.className = 'status err'; status.textContent = 'Pick a player + program.'; return; }
  if (mode === 'absolute' && !Number.isFinite(target))  { status.className = 'status err'; status.textContent = 'Set a target price.'; return; }
  if (mode === 'percent'  && !Number.isFinite(percent)) { status.className = 'status err'; status.textContent = 'Set a discount %.'; return; }
  const p = searchCache[idx];
  status.innerHTML = '<span class="spinner"></span> Adding…';
  try {
    await api('/api/watches', { method: 'POST', body: JSON.stringify({
      externalId: p.externalId, gameSlug: p.gameSlug, url: p.url,
      name: p.firstName + ' ' + p.lastName, program: p.program?.name, ovr: p.overall,
      platform: $('#f-platform').value,
      targetMode: mode,
      targetBin:     mode === 'absolute' ? target  : null,
      targetPercent: mode === 'percent'  ? percent : null,
      recurring,
    })});
    status.className = 'status ok'; status.textContent = 'Added.';
    $('#f-name').value = ''; $('#f-ovr').value = ''; $('#f-target').value = ''; $('#f-percent').value = '';
    $('#f-program').innerHTML = '<option value="">— search a player first —</option>';
    searchRaw = []; searchCache = [];
    refresh();
  } catch (e) { status.className = 'status err'; status.textContent = 'Failed: ' + e.message; }
};

$('#btn-add-filter').onclick = async () => {
  const overallMin = parseInt($('#ff-min').value, 10);
  const overallMax = parseInt($('#ff-max').value, 10);
  const platform   = $('#ff-platform').value;
  const programFilter   = $('#ff-program').value;
  const excludePrograms = ($('#ff-exclude').value || '').split(',').map(s => s.trim()).filter(Boolean);
  const mode      = $('#ff-mode').value;
  const targetBin = parseInt(($('#ff-target').value  || '').replace(/[^\\d]/g,''), 10);
  const percent   = parseInt(($('#ff-percent').value || '').replace(/[^\\d]/g,''), 10);
  const status = $('#add-status'); status.className = 'status'; status.textContent = '';
  if (!Number.isFinite(overallMin) || !Number.isFinite(overallMax) || overallMin > overallMax) {
    status.className = 'status err'; status.textContent = 'Set a valid OVR range (min ≤ max, 0–99).'; return;
  }
  if (mode === 'absolute' && !Number.isFinite(targetBin)) {
    status.className = 'status err'; status.textContent = 'Set a target price.'; return;
  }
  if (mode === 'percent' && !Number.isFinite(percent)) {
    status.className = 'status err'; status.textContent = 'Set a discount %.'; return;
  }
  status.innerHTML = '<span class="spinner"></span> Discovering candidate cards… (this can take ~10 seconds)';
  try {
    const r = await api('/api/watches/filter', { method: 'POST', body: JSON.stringify({
      overallMin, overallMax, platform,
      programFilter,
      excludePrograms,
      targetMode: mode,
      targetBin:     mode === 'absolute' ? targetBin : null,
      targetPercent: mode === 'percent'  ? percent   : null,
      recurring: filterRecurring,
    })});
    status.className = 'status ok';
    status.textContent = 'Added. ' + r.watch.candidateCount + ' candidate cards will rotate through polling.';
    $('#ff-min').value = ''; $('#ff-max').value = ''; $('#ff-target').value = ''; $('#ff-percent').value = ''; $('#ff-program').value = ''; $('#ff-exclude').value = '';
    refresh();
  } catch (e) { status.className = 'status err'; status.textContent = 'Failed: ' + e.message; }
};

$('#btn-test').onclick = async () => {
  const ls = $('#log-status'); ls.className = 'status'; ls.textContent = 'Sending test…';
  try { const r = await api('/api/test', { method: 'POST' }); ls.className = 'status ok'; ls.textContent = r.ok ? 'Test sent ✓' : ('Test failed: ' + JSON.stringify(r)); }
  catch (e) { ls.className = 'status err'; ls.textContent = 'Test error: ' + e.message; }
};

$('#btn-poll').onclick = async () => {
  const ls = $('#log-status'); ls.className = 'status'; ls.textContent = 'Polling…';
  try { const r = await api('/api/poll', { method: 'POST' }); ls.className = 'status ok'; ls.textContent = 'Polled ' + (r.polled || 0) + ' watches.'; refresh(); }
  catch (e) { ls.className = 'status err'; ls.textContent = 'Poll error: ' + e.message; }
};

async function snapshot(w) {
  try {
    return await api('/api/snapshot?externalId=' + w.externalId + '&platform=' + w.platform + '&gameSlug=' + (w.gameSlug || '26'));
  } catch { return {}; }
}

async function refresh() {
  const log = $('#log');
  log.innerHTML = '<div class="empty"><span class="spinner"></span> Loading watches…</div>';
  let watches;
  try { ({ watches } = await api('/api/watches')); } catch (e) { log.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; return; }
  const ids = Object.keys(watches);
  if (ids.length === 0) { log.innerHTML = '<div class="empty">No watches yet. Add one above.</div>'; return; }
  log.innerHTML = '';
  for (const id of ids) {
    const w = watches[id];
    const card = document.createElement('div'); card.className = 'alert';

    if (w.kind === 'filter') {
      // Filter watch row: no single player; summarize the OVR range.
      const swept = w.candidateCount ? Math.round((w.cursor || 0) / w.candidateCount * 100) : 0;
      const targetDisplay = w.targetMode === 'percent' ? (w.targetPercent + '% off') : fmt(w.targetBin);
      const subParts = [
        PLATFORMS[w.platform] || w.platform,
        (w.candidateCount ?? '?') + ' candidate cards',
      ];
      if (w.programFilter) subParts.push('program: ' + w.programFilter);
      if (w.excludePrograms && w.excludePrograms.length) {
        subParts.push('excluding: ' + w.excludePrograms.join(', '));
      }
      card.innerHTML = \`
        <div class="ovr">\${w.overallMin}–\${w.overallMax}</div>
        <div>
          <div><span class="meta-name">FILTER · \${w.overallMin}-\${w.overallMax} OVR\${w.programFilter ? ' · ' + w.programFilter.toUpperCase() : ''}</span></div>
          <div class="sub">\${subParts.join(' · ')}</div>
          <div class="prices">
            <div class="price target"><div class="v">\${targetDisplay}</div><div class="l">TARGET</div></div>
            <div class="price med"><div class="v">\${swept}%</div><div class="l">Sweep</div></div>
          </div>
          <div style="margin-top:8px;">
            <button class="pill \${w.recurring?'on':'off'}" data-action="rec">\${w.recurring?'RECURRING':'ONE-SHOT'}</button>
            \${w.lastAlertedAt ? '<span class="alerted-at">Last alert: ' + (w.lastAlertedName ? w.lastAlertedName + ' @ ' + fmt(w.lastAlertedPrice) + ' · ' : '') + new Date(w.lastAlertedAt).toLocaleString() + '</span>' : ''}
          </div>
          \${w.lastError ? '<div class="status err">⚠️ ' + w.lastError + '</div>' : ''}
        </div>
        <div class="actions">
          <a class="iconbtn edit" title="Manage exclusions" href="/manage/\${encodeURIComponent(w.id)}" style="text-decoration:none;text-align:center;line-height:34px;">✎</a>
          <button class="iconbtn edit" title="Re-discover candidates" data-action="refresh">↻</button>
          <button class="iconbtn del" title="Remove" data-action="del">✕</button>
        </div>
      \`;
      card.querySelector('[data-action=rec]').onclick = async () => {
        await api('/api/watches/filter', { method: 'POST', body: JSON.stringify({
          overallMin: w.overallMin, overallMax: w.overallMax, platform: w.platform,
          programFilter: w.programFilter || '',
          excludePrograms: w.excludePrograms || [],
          excludeExternalIds: w.excludeExternalIds || [],
          targetMode: w.targetMode || 'absolute',
          targetBin: w.targetBin, targetPercent: w.targetPercent,
          recurring: !w.recurring,
        })});
        refresh();
      };
      card.querySelector('[data-action=refresh]').onclick = async () => {
        const r = await api('/api/watches/' + encodeURIComponent(w.id) + '/refresh', { method: 'POST' });
        alert('Re-discovered ' + r.candidateCount + ' candidates.');
        refresh();
      };
      card.querySelector('[data-action=del]').onclick = async () => {
        if (!confirm('Remove filter watch ' + w.overallMin + '-' + w.overallMax + ' OVR (' + w.platform + ')?')) return;
        await api('/api/watches/' + encodeURIComponent(w.id), { method: 'DELETE' });
        refresh();
      };
      log.appendChild(card);
      continue;
    }

    // Card watch row.
    // Prefer cached snapshot values from the cron poll — avoids extra mut.gg fetches
    // from the UI (which was triggering the "..." display via rate-limited fetches).
    const cachedBin = w.cachedCheapestBin;
    const cachedMed = w.cachedMed;
    const haveCache = w.cachedSnapshotAt != null;
    const targetDisplay = w.targetMode === 'percent' && cachedMed != null
      ? fmt(Math.floor(cachedMed * (1 - (w.targetPercent || 0) / 100)))
      : (w.targetMode === 'percent' ? (w.targetPercent + '% off') : fmt(w.targetBin));
    card.innerHTML = \`
      <div class="ovr">\${w.ovr ?? '?'}</div>
      <div>
        <div><span class="meta-name">\${w.name?.toUpperCase()}</span></div>
        <div class="sub">\${w.program} · \${PLATFORMS[w.platform] || w.platform}</div>
        <div class="prices">
          <div class="price bin"><div class="v" data-k="bin">\${haveCache ? fmt(cachedBin) : '…'}</div><div class="l">BIN</div></div>
          <div class="price med"><div class="v" data-k="med">\${haveCache ? fmt(cachedMed) : '…'}</div><div class="l">MED</div></div>
          <div class="price target"><div class="v">\${targetDisplay}</div><div class="l">TARGET</div></div>
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
    // Cache miss (newly added watch hasn't been polled yet) — fetch live once
    // so the user doesn't stare at "..." for a full minute.
    if (!haveCache) {
      snapshot(w).then(s => {
        card.querySelector('[data-k=bin]').textContent = fmt(s.cheapestBin);
        card.querySelector('[data-k=med]').textContent = fmt(s.med);
      });
    }
  }
}

refresh();
setInterval(refresh, 60_000);  // refresh card view every 60s; cron polls every minute independently
</script>
</body></html>`;

// ---------- /manage/:watchId — interactive exclusion picker ----------

const MANAGE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Manage Exclusions — MUT.GG Auction Alerts</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background:#0b0f12; color:#e7e9ea; font:14px/1.45 system-ui,sans-serif; margin:0; padding:24px; max-width:1100px; margin-inline:auto; }
h1 { font-size:20px; margin:0 0 4px; }
.lede { color:#9aa3ad; margin:0 0 16px; font-size:13px; }
.back { color:#7ed996; text-decoration:none; font-size:12px; }
.bar {
  display:flex; gap:12px; align-items:center; flex-wrap:wrap;
  position:sticky; top:0; padding:10px 14px; background:#11161a;
  border:1px solid #232b33; border-radius:8px; margin-bottom:16px; z-index:5;
}
.stat { color:#9aa3ad; font-size:12px; }
.stat b { color:#e7e9ea; font-weight:600; }
input[type=search] { background:#1a2229; color:#e7e9ea; border:1px solid #2a3540; border-radius:6px; padding:6px 10px; font:inherit; min-width:220px; }
button { background:#1a2229; color:#e7e9ea; border:1px solid #2a3540; border-radius:6px; padding:7px 12px; font:inherit; cursor:pointer; }
button.primary { background:#1f5b3a; border-color:#2a7a4d; font-weight:600; }
button.primary:hover { background:#2a7a4d; }
button.danger { background:#5b1f1f; border-color:#7a2a2a; }
button:disabled { opacity:.5; cursor:default; }
.prog {
  background:#11161a; border:1px solid #232b33; border-radius:8px;
  padding:10px 14px; margin-bottom:10px;
}
.prog header {
  display:flex; align-items:center; gap:10px; cursor:pointer; user-select:none;
}
.prog h2 { font-size:14px; margin:0; font-weight:600; }
.prog .count { color:#9aa3ad; font-size:11px; margin-left:auto; }
.prog .indicator { color:#677079; transition:transform 0.15s; }
.prog.open .indicator { transform:rotate(90deg); }
.prog .body { display:none; margin-top:10px; }
.prog.open .body { display:block; }
.prog.excluded { opacity:.45; }
.prog.excluded h2 { text-decoration:line-through; }
.card-row {
  display:grid; grid-template-columns:auto 36px 1fr 100px 100px; gap:10px; align-items:center;
  padding:5px 4px; border-top:1px solid #1a2229;
}
.card-row:first-child { border-top:none; }
.card-row.excluded label { opacity:.45; text-decoration:line-through; }
.card-row .ovr { font:italic 700 14px monospace; color:#9aa3ad; text-align:center; }
.card-row .name { font-size:13px; }
.card-row .arch { color:#9aa3ad; font-size:11px; }
.card-row .id   { color:#677079; font-size:10px; font-family:ui-monospace,monospace; text-align:right; }
input[type=checkbox] { width:16px; height:16px; cursor:pointer; }
.empty { color:#677079; text-align:center; padding:48px; font-size:13px; }
.spinner { display:inline-block; width:14px; height:14px; border:2px solid #2a3540; border-top-color:#7ed996; border-radius:50%; animation:spin 0.8s linear infinite; vertical-align:middle; }
@keyframes spin { to { transform:rotate(360deg); } }
.toast { position:fixed; bottom:20px; right:20px; background:#1f5b3a; color:#fff; padding:10px 14px; border-radius:8px; opacity:0; transition:opacity 0.2s; z-index:100; }
.toast.show { opacity:1; }
.toast.err { background:#5b1f1f; }
</style>
</head><body>

<a href="/" class="back">← back to main</a>
<h1 id="title">Manage exclusions</h1>
<p class="lede" id="lede">Loading…</p>

<div class="bar">
  <input id="search" type="search" placeholder="Filter by name, program, position…">
  <div class="stat"><b id="totalCount">—</b> total · <b id="activeCount">—</b> active · <b id="excludedCount">—</b> excluded</div>
  <span style="flex:1"></span>
  <button id="expandAll" type="button">Expand all</button>
  <button id="collapseAll" type="button">Collapse all</button>
  <button id="save" class="primary" type="button" disabled>Save exclusions</button>
</div>

<div id="programs"></div>
<div id="toast" class="toast"></div>

<script>
const $ = s => document.querySelector(s);

function auth() {
  let s = localStorage.getItem('mutgg.auth');
  if (!s) { s = prompt('Enter AUTH_SECRET (set via wrangler):') || ''; if (s) localStorage.setItem('mutgg.auth', s); }
  return s;
}

async function api(path, opts={}) {
  const r = await fetch(path, { ...opts, headers: { 'X-Auth': auth(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { localStorage.removeItem('mutgg.auth'); throw new Error('unauthorized'); }
  return await r.json();
}

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

const watchId = decodeURIComponent(location.pathname.replace('/manage/', ''));
let cards = [];           // all candidates ignoring exclusions
let excludedIds = new Set();
let excludedPrograms = new Set();
let dirty = false;

function setDirty(d) { dirty = d; $('#save').disabled = !d; }

function programsOf(cards) {
  const map = new Map();
  for (const c of cards) {
    if (!map.has(c.program)) map.set(c.program, []);
    map.get(c.program).push(c);
  }
  // sort by program size desc
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

function updateCounts() {
  const active = cards.filter(c => !excludedIds.has(c.externalId) && !excludedPrograms.has(c.program.toLowerCase())).length;
  $('#totalCount').textContent = cards.length;
  $('#activeCount').textContent = active;
  $('#excludedCount').textContent = cards.length - active;
}

function render() {
  const groups = programsOf(cards);
  const root = $('#programs');
  root.innerHTML = '';
  for (const [prog, cs] of groups) {
    const isProgExcl = excludedPrograms.has(prog.toLowerCase());
    const activeInProg = cs.filter(c => !excludedIds.has(c.externalId)).length;
    const sec = document.createElement('section');
    sec.className = 'prog' + (isProgExcl ? ' excluded' : '');
    sec.dataset.program = prog.toLowerCase();
    sec.innerHTML = \`
      <header>
        <span class="indicator">▶</span>
        <input type="checkbox" class="prog-check" \${isProgExcl ? '' : 'checked'} title="Uncheck to exclude this entire program">
        <h2>\${prog}</h2>
        <span class="count">\${activeInProg}/\${cs.length} active</span>
      </header>
      <div class="body"></div>
    \`;
    const body = sec.querySelector('.body');
    for (const c of cs) {
      const excluded = excludedIds.has(c.externalId) || isProgExcl;
      const row = document.createElement('div');
      row.className = 'card-row' + (excluded ? ' excluded' : '');
      row.innerHTML = \`
        <input type="checkbox" class="card-check" data-id="\${c.externalId}" \${excluded ? '' : 'checked'} \${isProgExcl ? 'disabled' : ''}>
        <span class="ovr">\${c.ovr}</span>
        <label>\${c.firstName ? (c.firstName + ' ' + c.lastName) : c.name}</label>
        <span class="arch">\${c.archetype || ''}</span>
        <span class="id">\${c.externalId}</span>
      \`;
      body.appendChild(row);
    }
    // Header click toggles expand
    sec.querySelector('header').addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      sec.classList.toggle('open');
    });
    sec.querySelector('.prog-check').addEventListener('change', e => {
      const checked = e.target.checked;
      if (checked) excludedPrograms.delete(prog.toLowerCase());
      else excludedPrograms.add(prog.toLowerCase());
      setDirty(true);
      render();
    });
    body.querySelectorAll('.card-check').forEach(cb => {
      cb.addEventListener('change', e => {
        const id = Number(e.target.dataset.id);
        if (e.target.checked) excludedIds.delete(id);
        else excludedIds.add(id);
        setDirty(true);
        updateCounts();
        e.target.closest('.card-row').classList.toggle('excluded', !e.target.checked);
        // update the program's active count label
        const totalInProg = cs.length;
        const activeNow = cs.filter(c => !excludedIds.has(c.externalId)).length;
        sec.querySelector('.count').textContent = activeNow + '/' + totalInProg + ' active';
      });
    });
    root.appendChild(sec);
  }
  applyFilter();
  updateCounts();
}

function applyFilter() {
  const q = $('#search').value.trim().toLowerCase();
  for (const sec of document.querySelectorAll('.prog')) {
    let anyVisible = false;
    for (const row of sec.querySelectorAll('.card-row')) {
      const text = row.textContent.toLowerCase();
      const match = !q || text.includes(q);
      row.style.display = match ? '' : 'none';
      if (match) anyVisible = true;
    }
    sec.style.display = anyVisible ? '' : 'none';
    if (q && anyVisible) sec.classList.add('open');
  }
}
$('#search').addEventListener('input', applyFilter);
$('#expandAll').onclick = () => document.querySelectorAll('.prog').forEach(s => s.classList.add('open'));
$('#collapseAll').onclick = () => document.querySelectorAll('.prog').forEach(s => s.classList.remove('open'));

$('#save').onclick = async () => {
  const btn = $('#save');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';
  try {
    const r = await api('/api/watches/' + encodeURIComponent(watchId) + '/exclusions', {
      method: 'POST',
      body: JSON.stringify({
        excludePrograms: [...excludedPrograms],
        excludeExternalIds: [...excludedIds],
      }),
    });
    toast('Saved · ' + r.candidateCount + ' active cards');
    dirty = false;
    btn.innerHTML = 'Save exclusions';
  } catch (e) {
    toast('Save failed: ' + e.message, true);
    btn.innerHTML = 'Save exclusions';
    btn.disabled = false;
  }
};

window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

(async function load() {
  try {
    const r = await api('/api/watches/' + encodeURIComponent(watchId) + '/all-candidates');
    cards = r.candidates;
    excludedIds = new Set((r.excludeExternalIds || []).map(Number));
    excludedPrograms = new Set((r.excludePrograms || []).map(p => p.toLowerCase()));
    const w = r.watch || {};
    $('#title').textContent = 'Manage exclusions · ' + w.overallMin + '–' + w.overallMax + ' OVR · ' + (w.platform || '?');
    $('#lede').innerHTML = cards.length + ' total candidates' + (w.programFilter ? ' (program filter: <b>' + w.programFilter + '</b>)' : '') + '. Uncheck cards or programs to skip them; the cron will stop polling those once you Save.';
    render();
  } catch (e) {
    $('#programs').innerHTML = '<div class="empty">Error: ' + e.message + '</div>';
  }
})();
</script>
</body></html>`;
