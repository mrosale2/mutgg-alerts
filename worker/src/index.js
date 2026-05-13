// MUT.GG Live Auction Alerts — Cloudflare Worker
//
// Two entrypoints:
//   - scheduled(): cron-triggered every 2 min, polls mut.gg and fires Discord alerts
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
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { ...BROWSER_HEADERS, ...(init.headers || {}) },
    });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
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

// ---------- KV ----------

async function loadWatches(env) {
  const raw = await env.WATCHES.get('watches');
  return raw ? JSON.parse(raw) : {};
}
async function saveWatches(env, watches) {
  await env.WATCHES.put('watches', JSON.stringify(watches));
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

async function pollOnce(env) {
  const webhook = env.DISCORD_WEBHOOK;
  if (!webhook) return { skipped: 'no DISCORD_WEBHOOK secret' };

  const watches = await loadWatches(env);
  const ids = Object.keys(watches);
  const results = [];

  // Dedupe fetches: multiple watches can share the same (gameSlug, externalId, platform).
  // Fetch each unique card once per tick and evaluate every watch against the cached result.
  // Keeps us well under Cloudflare's subrequest cap and reduces load on mut.gg.
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
    const matches = liveAuctions.filter(a =>
      a.buyNowPrice != null && (w.targetBin == null || a.buyNowPrice <= w.targetBin)
    );
    const cheapest = matches.reduce(
      (m, a) => (m == null || a.buyNowPrice < m.buyNowPrice) ? a : m,
      null
    );

    // Alert rule: fire once when a qualifying listing first appears, then only re-fire
    // if a strictly cheaper listing shows up later. Never re-fire at the same price,
    // even after a player relists.
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
    results.push({ id, name: w.name, matches: matches.length, cheapest: cheapest?.buyNowPrice ?? null, fired });
  }

  await saveWatches(env, watches);
  return { polled: ids.length, uniqueFetches: uniqueKeys.length, results };
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

  // Add or update a watch
  if (req.method === 'POST' && path === '/api/watches') {
    const body = await req.json();
    const { externalId, gameSlug, url: playerUrl, name, program, ovr, platform, targetBin, recurring } = body;
    if (!externalId || !platform) return jsonResponse({ error: 'missing externalId or platform' }, { status: 400 });
    const id = `${externalId}-${platform}`;
    const watches = await loadWatches(env);
    watches[id] = {
      id, externalId, gameSlug: gameSlug || '26', url: playerUrl, name, program, ovr,
      platform,
      targetBin: targetBin == null ? null : Number(targetBin),
      recurring: !!recurring,
      lastChecked: watches[id]?.lastChecked || 0,
      lastError:   null,
      lastAlertedAt: watches[id]?.lastAlertedAt || null,
      lastAlertedPrice: watches[id]?.lastAlertedPrice || null,
    };
    await saveWatches(env, watches);
    return jsonResponse({ ok: true, watch: watches[id] });
  }

  // Delete a watch
  if (req.method === 'DELETE' && path.startsWith('/api/watches/')) {
    const id = decodeURIComponent(path.slice('/api/watches/'.length));
    const watches = await loadWatches(env);
    delete watches[id];
    await saveWatches(env, watches);
    await env.WATCHES.delete(`seen:${id}`);
    return jsonResponse({ ok: true });
  }

  // Player search → returns auctionable cards for the surname provided
  if (req.method === 'GET' && path === '/api/search') {
    const name = url.searchParams.get('name') || '';
    if (!name) return jsonResponse({ data: [] });
    const data = await searchPlayer(name);
    return jsonResponse({ data });
  }

  // Snapshot prices for one card (used to render BIN/MED on the alert log)
  if (req.method === 'GET' && path === '/api/snapshot') {
    const externalId = url.searchParams.get('externalId');
    const platform   = url.searchParams.get('platform');
    const gameSlug   = url.searchParams.get('gameSlug') || '26';
    if (!externalId || !platform) return jsonResponse({ error: 'missing externalId/platform' }, { status: 400 });
    try {
      const [{ liveAuctions, lastUpdate }, overall] = await Promise.all([
        fetchLiveAuctions(gameSlug, externalId, platform),
        fetchOverallPrices(externalId).catch(() => null),
      ]);
      const cheapestBin = liveAuctions.reduce((m, a) => a.buyNowPrice != null && (m == null || a.buyNowPrice < m) ? a.buyNowPrice : m, null);
      const med = overall?.price?.[platform] ?? null;
      return jsonResponse({ cheapestBin, med, liveCount: liveAuctions.length, lastUpdate });
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

// ---------- worker entrypoints ----------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollOnce(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, url);
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
<p class="lede">Always-on. Polls mut.gg every 2 minutes. Pings Discord when BIN ≤ target.</p>

<div class="card">
  <div class="row" style="gap:12px;">
    <div class="grow">
      <label>Player</label>
      <input id="f-name" placeholder="Tyreek Hill" autocomplete="off">
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

let searchCache = [];  // cards returned for the current name query
let recurring = true;
$('#f-recurring').onclick = () => {
  recurring = !recurring;
  $('#f-recurring').classList.toggle('on', recurring);
  $('#f-recurring').classList.toggle('off', !recurring);
  $('#f-recurring').textContent = recurring ? 'Yes' : 'No';
};

let searchTimer;
$('#f-name').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const name = $('#f-name').value.trim();
  const sel = $('#f-program');
  sel.innerHTML = '<option value="">— typing… —</option>';
  if (!name) { sel.innerHTML = '<option value="">— search a player first —</option>'; return; }
  searchTimer = setTimeout(async () => {
    try {
      const { data } = await api('/api/search?name=' + encodeURIComponent(name));
      const wantFirst = name.trim().split(/\\s+/).slice(0,-1).join(' ').toLowerCase();
      const wantLast  = name.trim().split(/\\s+/).pop().toLowerCase();
      const cards = data.filter(p => p.lastName.toLowerCase() === wantLast && (!wantFirst || p.firstName.toLowerCase().startsWith(wantFirst)));
      searchCache = cards;
      if (cards.length === 0) { sel.innerHTML = '<option value="">— no auctionable matches —</option>'; return; }
      sel.innerHTML = cards.map((p, i) => '<option value="' + i + '">' + p.program?.name + ' · ' + p.overall + ' OVR</option>').join('');
    } catch (e) { sel.innerHTML = '<option value="">— error: ' + e.message + ' —</option>'; }
  }, 300);
});

$('#btn-add').onclick = async () => {
  const idx = $('#f-program').value;
  const target = parseInt(($('#f-target').value || '').replace(/[^\\d]/g,''), 10);
  const status = $('#add-status'); status.className = 'status'; status.textContent = '';
  if (!searchCache[idx]) { status.className = 'status err'; status.textContent = 'Pick a player + program.'; return; }
  const p = searchCache[idx];
  status.innerHTML = '<span class="spinner"></span> Adding…';
  try {
    await api('/api/watches', { method: 'POST', body: JSON.stringify({
      externalId: p.externalId, gameSlug: p.gameSlug, url: p.url,
      name: p.firstName + ' ' + p.lastName, program: p.program?.name, ovr: p.overall,
      platform: $('#f-platform').value,
      targetBin: Number.isFinite(target) ? target : null,
      recurring,
    })});
    status.className = 'status ok'; status.textContent = 'Added.';
    $('#f-name').value = ''; $('#f-target').value = ''; $('#f-program').innerHTML = '<option value="">— search a player first —</option>';
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
    // Fire snapshot in background
    snapshot(w).then(s => {
      card.querySelector('[data-k=bin]').textContent = fmt(s.cheapestBin);
      card.querySelector('[data-k=med]').textContent = fmt(s.med);
    });
  }
}

refresh();
setInterval(refresh, 60_000);  // refresh card view every 60s; cron polls every 2 min independently
</script>
</body></html>`;
