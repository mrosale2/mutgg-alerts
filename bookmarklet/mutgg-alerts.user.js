// ==UserScript==
// @name         MUT.GG Live Auction Alerts
// @namespace    mattrosa.mutgg
// @version      0.3.0
// @description  Alerts (phone/desktop) when MUT.GG sees a new live auction for selected players at or below your price. One-shot form: player + program + max price. Delivers via ntfy.sh and/or Discord webhook.
// @match        https://www.mut.gg/*
// @match        https://mut.gg/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // ---------- config ----------
  const POLL_MS         = 150_000;                   // 2.5 min
  const STORAGE_KEY     = 'mutgg-alerts.v1';
  const SOUND_DATA_URI  = 'data:audio/wav;base64,UklGRoQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YWAAAAAAACAAQABgAH8AnwC+ANwA+QAUAS0BRAFZAWoBeQGEAYwBkAGRAY4BiAF+AXEBYAFLATQBGgH+AOAAvwCcAHcAUAAoAAAA1//Q/8H/sP+f/47/fv9w/2T/Wv9S/03/Sv9K/03/Uv9a/2T/cP9+/47/n/+w/8H/0v/k//X/';

  // Endpoints decoded from mut.gg JS bundle 2026-05-10
  const SEARCH_URL = name => `/api/mutdb/player-items/?name=${encodeURIComponent(name)}`;
  const PRICES_URL = (gameSlug, externalId, platform) =>
    `/api/mutdb/prices/${gameSlug}-${externalId}/${platform}/`;

  const PLATFORMS = [
    { id: 'pc',              label: 'PC' },
    { id: 'xbox-series-x',   label: 'Xbox Series X' },
    { id: 'playstation-5',   label: 'PlayStation 5' },
  ];

  // ---------- state ----------
  const defaultState = () => ({ watches: [], delivery: { ntfyTopic: '', discordWebhook: '' } });
  const load = () => { try { return Object.assign(defaultState(), JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}); } catch { return defaultState(); } };
  const save = s => localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  let state = load();
  if (!state.delivery) state.delivery = { ntfyTopic: '', discordWebhook: '' };

  // watch = { id, externalId, gameSlug, url, name, program, ovr, platform, maxBin, seenKeys, lastChecked, lastError }

  // ---------- helpers ----------
  const sig = a => `${a.endDate}|${a.buyNowPrice}|${a.startingBid}`;
  const fmt = n => n == null ? '—' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? Math.round(n/1e3)+'K' : ''+n;
  const parsePrice = s => { if (!s) return null; const n = parseInt(String(s).replace(/[^\d]/g,''), 10); return Number.isFinite(n) ? n : null; };

  async function searchByName(fullName) {
    // mut.gg supports ?name=<token>. Try last word, then full string.
    const tokens = fullName.trim().split(/\s+/);
    const lastTok = tokens[tokens.length-1] || fullName;
    const r = await fetch(SEARCH_URL(lastTok));
    if (!r.ok) throw new Error('search failed: '+r.status);
    const j = await r.json();
    return (j.data || []).filter(p => p.canAuction);
  }

  function resolveOne(candidates, fullName, programQuery) {
    const fnTok = fullName.trim().split(/\s+/);
    const wantFirst = fnTok.length > 1 ? fnTok.slice(0, -1).join(' ').toLowerCase() : '';
    const wantLast  = (fnTok[fnTok.length-1] || '').toLowerCase();
    const pq        = (programQuery || '').toLowerCase().trim();

    return candidates.filter(p => {
      const fn = (p.firstName || '').toLowerCase();
      const ln = (p.lastName  || '').toLowerCase();
      const pr = (p.program?.name || '').toLowerCase();
      const nameOk = ln === wantLast && (!wantFirst || fn.startsWith(wantFirst));
      const progOk = !pq || pr.includes(pq);
      return nameOk && progOk;
    });
  }

  async function fetchAuctions(w) {
    const r = await fetch(PRICES_URL(w.gameSlug, w.externalId, w.platform));
    if (!r.ok) throw new Error('prices failed: '+r.status);
    const j = await r.json();
    return j.data?.pricesData?.liveAuctions || [];
  }

  // ---------- delivery ----------
  async function ensureNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied')  return false;
    return (await Notification.requestPermission()) === 'granted';
  }

  function beep() { try { new Audio(SOUND_DATA_URI).play().catch(()=>{}); } catch {} }

  async function sendNtfy(topic, title, body, url) {
    if (!topic) return;
    try {
      // Use JSON publishing so UTF-8 (emoji) in title doesn't violate HTTP header rules.
      const payload = { topic, title, message: body };
      if (url) payload.click = url;
      const r = await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) log(`⚠️ ntfy ${r.status}`);
    } catch (e) { log('⚠️ ntfy failed: '+e.message); }
  }

  async function sendDiscord(webhook, title, body, url) {
    if (!webhook) return;
    try {
      const payload = {
        embeds: [{ title, description: body, url: url || undefined, color: 0x1f5b3a, timestamp: new Date().toISOString() }]
      };
      const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok && r.status !== 204) log(`⚠️ discord ${r.status}`);
    } catch (e) { log('⚠️ discord failed: '+e.message); }
  }

  function notify(title, body, url) {
    beep();
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: title, requireInteraction: true });
      n.onclick = () => { window.focus(); if (url) window.open(url, '_blank'); n.close(); };
    }
    sendNtfy(state.delivery.ntfyTopic, title, body, url);
    sendDiscord(state.delivery.discordWebhook, title, body, url);
    log(`🔔 ${title} — ${body}`);
  }

  // ---------- polling ----------
  let pollTimer = null;
  async function pollAll() {
    for (const w of state.watches) {
      try {
        const auctions  = await fetchAuctions(w);
        const seen      = new Set(w.seenKeys || []);
        const fresh     = auctions.filter(a => !seen.has(sig(a)));
        const isFirstRun = !w.lastChecked;
        const prevCount  = seen.size;

        w.seenKeys    = auctions.map(sig);
        w.lastChecked = Date.now();
        w.lastError   = null;

        if (!isFirstRun) {
          for (const a of fresh) {
            const price = a.buyNowPrice;
            if (w.maxBin != null && (price == null || price > w.maxBin)) continue;
            const wasUnknown = prevCount === 0;
            const title = w.maxBin != null
              ? `🎯 SNIPE: ${w.name} (${w.program}) ${w.platform.toUpperCase()} — ${fmt(price)}`
              : wasUnknown
                ? `🆕 First listing: ${w.name} (${w.program}) ${w.platform.toUpperCase()}`
                : `📬 New listing: ${w.name} (${w.program}) ${w.platform.toUpperCase()} — BIN ${fmt(price)}`;
            const body = `BIN ${fmt(price)} · bid ${fmt(a.currentBid ?? a.startingBid)} · ends ${new Date(a.endDate).toLocaleTimeString()}`;
            notify(title, body, `https://www.mut.gg${w.url}#prices`);
          }
        }
      } catch (e) {
        w.lastError = e.message;
        log(`⚠️ ${w.name} (${w.program}) ${w.platform}: ${e.message}`);
      }
    }
    save(state);
    render();
  }

  function startPolling() {
    if (pollTimer) return;
    pollAll();
    pollTimer = setInterval(pollAll, POLL_MS);
  }

  // ---------- UI ----------
  const PANEL_ID = 'mutgg-alerts-panel';
  const $ = (sel, root=document) => root.querySelector(sel);
  function el(tag, attrs={}, ...kids) {
    const e = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs)) {
      if (k === 'style') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  }

  let logLines = [];
  function log(line) {
    const ts = new Date().toLocaleTimeString();
    logLines.unshift(`[${ts}] ${line}`);
    logLines = logLines.slice(0, 40);
    const lb = $('#mutgg-log');
    if (lb) lb.textContent = logLines.join('\n');
  }

  function injectStyles() {
    if ($('#mutgg-alerts-styles')) return;
    document.head.append(el('style', { id: 'mutgg-alerts-styles' }, `
      #${PANEL_ID} {
        position: fixed; bottom: 12px; right: 12px;
        width: 380px; max-height: 86vh; overflow: auto;
        background: #0f1418; color: #e7e9ea; font: 13px/1.4 system-ui, sans-serif;
        border: 1px solid #283139; border-radius: 8px; z-index: 2147483647;
        box-shadow: 0 8px 28px rgba(0,0,0,.6);
      }
      #${PANEL_ID} header {
        display:flex; align-items:center; justify-content:space-between;
        padding:8px 10px; background:#151b21; border-bottom:1px solid #283139;
        cursor:move; user-select:none;
      }
      #${PANEL_ID} h2 { margin:0; font-size:13px; font-weight:600; }
      #${PANEL_ID} .body { padding:10px; }
      #${PANEL_ID} .grid { display:grid; grid-template-columns: 90px 1fr; gap:6px 8px; align-items:center; margin-bottom:6px; }
      #${PANEL_ID} .grid label { color:#9aa3ad; font-size:12px; }
      #${PANEL_ID} input, #${PANEL_ID} select, #${PANEL_ID} button {
        background:#1a2229; color:#e7e9ea; border:1px solid #2a3540; padding:5px 7px;
        border-radius:5px; font:inherit;
      }
      #${PANEL_ID} input, #${PANEL_ID} select { width:100%; box-sizing:border-box; }
      #${PANEL_ID} button { cursor:pointer; }
      #${PANEL_ID} button.primary { background:#1f5b3a; border-color:#2a7a4d; }
      #${PANEL_ID} button.danger  { background:#5b1f1f; border-color:#7a2a2a; }
      #${PANEL_ID} .actions { display:flex; gap:6px; margin-top:8px; }
      #${PANEL_ID} .actions button { flex:1; }
      #${PANEL_ID} .watch {
        border:1px solid #283139; border-radius:6px; padding:7px 9px; margin:6px 0;
        background:#13191e; display:flex; justify-content:space-between; align-items:flex-start; gap:6px;
      }
      #${PANEL_ID} .watch .meta { color:#9aa3ad; font-size:11px; margin-top:2px; }
      #${PANEL_ID} details { margin-top:10px; border-top:1px solid #283139; padding-top:8px; }
      #${PANEL_ID} details summary { cursor:pointer; color:#9aa3ad; font-size:12px; outline:none; }
      #${PANEL_ID} #mutgg-log {
        font: 11px/1.4 ui-monospace, monospace; color:#9aa3ad;
        background:#0a0f12; border:1px solid #1f262d; border-radius:5px; padding:6px;
        margin-top:8px; max-height:140px; overflow:auto; white-space:pre-wrap;
      }
      #${PANEL_ID}.collapsed .body { display:none; }
      #${PANEL_ID} .err { color:#ff8a8a; }
      #${PANEL_ID} .ok  { color:#7ed996; }
    `));
  }

  function render() {
    injectStyles();
    let p = $('#'+PANEL_ID);
    if (!p) { p = el('div', { id: PANEL_ID }); document.body.append(p); }
    p.innerHTML = '';

    p.append(el('header', {},
      el('h2', {}, '🔔 MUT.GG Auction Alerts'),
      el('button', { onclick: () => p.classList.toggle('collapsed') }, '–'),
    ));

    const body = el('div', { class:'body' });

    // One-shot add form
    const fName = el('input', { placeholder: 'e.g., Tyreek Hill' });
    const fProg = el('input', { placeholder: 'e.g., Sugar Rush' });
    const fPlat = el('select', {}, ...PLATFORMS.map(p => el('option', { value: p.id }, p.label)));
    fPlat.value = 'pc';
    const fMax  = el('input', { type: 'number', placeholder: 'e.g., 400000' });
    const status = el('div', { id: 'mutgg-status', style: { fontSize:'11px', minHeight:'14px', margin:'4px 0' } });

    body.append(
      el('div', { class: 'grid' },
        el('label', {}, 'Player'),     fName,
        el('label', {}, 'Program'),    fProg,
        el('label', {}, 'Platform'),   fPlat,
        el('label', {}, 'Alert ≤'),    fMax,
      ),
      status,
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: () => doAdd(fName.value, fProg.value, fPlat.value, fMax.value, status) }, 'Add watch'),
      ),
    );

    // Watches
    if (state.watches.length === 0) {
      body.append(el('div', { style: { color:'#9aa3ad', marginTop:'10px', fontSize:'12px' } }, 'No watches yet.'));
    } else {
      body.append(el('div', { style: { marginTop:'10px', fontSize:'12px', fontWeight:600 } }, `Watches (${state.watches.length})`));
      for (const w of state.watches) {
        body.append(el('div', { class:'watch' },
          el('div', {},
            el('div', {}, `${w.name} · ${w.program} · ${w.ovr} OVR`),
            el('div', { class:'meta' },
              `${PLATFORMS.find(p=>p.id===w.platform)?.label ?? w.platform}`,
              w.maxBin ? ` · ≤ ${fmt(w.maxBin)}` : ' · any new listing',
              w.lastChecked ? ` · checked ${new Date(w.lastChecked).toLocaleTimeString()}` : ' · pending',
              w.lastError ? ` · ⚠️ ${w.lastError}` : '',
            ),
          ),
          el('button', { class:'danger', onclick: () => { state.watches = state.watches.filter(x=>x.id!==w.id); save(state); render(); } }, '✕'),
        ));
      }
    }

    // Delivery settings (collapsed)
    const ntfy = el('input', { placeholder: 'e.g., matt-mutgg-9k2x', value: state.delivery.ntfyTopic });
    const disc = el('input', { placeholder: 'https://discord.com/api/webhooks/...', value: state.delivery.discordWebhook });
    const saveBtn = el('button', { class: 'primary', onclick: () => {
      state.delivery.ntfyTopic = ntfy.value.trim();
      state.delivery.discordWebhook = disc.value.trim();
      save(state); log('Delivery saved.');
    } }, 'Save');
    const testBtn = el('button', { onclick: () => notify('🧪 Test alert', 'If you see this on your phone, ntfy/Discord is wired correctly.', 'https://www.mut.gg/') }, 'Test');

    const settings = el('details', { id: 'mutgg-settings' },
      el('summary', {}, '⚙️ Alert delivery (Discord / ntfy)'),
      el('div', { style: { marginTop:'6px' } },
        el('div', { class: 'grid' },
          el('label', {}, 'Discord URL'),   disc,
          el('label', {}, 'ntfy topic'),    ntfy,
        ),
        el('div', { style: { fontSize:'11px', color:'#9aa3ad', marginTop:'4px' } },
          'Discord (recommended): in any server you control → Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL → paste above. Alerts appear in that channel and push to your phone via the Discord app. Tap Test to verify.'),
        el('div', { class: 'actions' }, saveBtn, testBtn),
      )
    );
    if (state.delivery.ntfyTopic || state.delivery.discordWebhook) settings.open = false; else settings.open = true;
    body.append(settings);

    body.append(
      el('div', { class: 'actions', style: { marginTop:'8px' } },
        el('button', { onclick: pollAll }, 'Poll now'),
        el('button', { onclick: ensureNotificationPermission }, 'Enable browser notif'),
        el('button', { onclick: () => { logLines=[]; log('cleared'); } }, 'Clear log'),
      ),
      el('pre', { id: 'mutgg-log' }, logLines.join('\n')),
    );

    p.append(body);
    makeDraggable(p);
  }

  function makeDraggable(p) {
    const h = p.querySelector('header');
    let sx=0,sy=0,startLeft=0,startTop=0,dragging=false;
    h.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const r = p.getBoundingClientRect();
      p.style.left = r.left+'px'; p.style.top = r.top+'px';
      p.style.right = 'auto'; p.style.bottom = 'auto';
      sx = e.clientX; sy = e.clientY; startLeft = r.left; startTop = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      p.style.left = (startLeft + e.clientX - sx) + 'px';
      p.style.top  = (startTop  + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => dragging = false);
  }

  async function doAdd(name, program, platform, maxStr, statusEl) {
    statusEl.className = ''; statusEl.textContent = '';
    name = (name||'').trim();
    program = (program||'').trim();
    if (!name) { statusEl.className='err'; statusEl.textContent = 'Player name required.'; return; }

    statusEl.textContent = 'Searching…';
    let candidates;
    try { candidates = await searchByName(name); }
    catch (e) { statusEl.className='err'; statusEl.textContent = 'Search failed: '+e.message; return; }

    const matches = resolveOne(candidates, name, program);
    if (matches.length === 0) {
      statusEl.className='err';
      statusEl.textContent = `No auctionable match for "${name}"${program?` in "${program}"`:''}.`;
      return;
    }
    if (matches.length > 1) {
      statusEl.className='err';
      const opts = matches.slice(0,4).map(p => `${p.firstName} ${p.lastName} · ${p.program?.name} · ${p.overall} OVR`).join('; ');
      statusEl.textContent = `Multiple matches; narrow program. (${opts})`;
      return;
    }

    const pick = matches[0];
    const maxBin = parsePrice(maxStr);
    const w = {
      id: `${pick.externalId}-${platform}`,
      externalId: pick.externalId,
      gameSlug:   pick.gameSlug,
      url:        pick.url,
      name:       `${pick.firstName} ${pick.lastName}`,
      program:    pick.program?.name ?? 'Unknown',
      ovr:        pick.overall,
      platform,
      maxBin,
      seenKeys: [], lastChecked: 0, lastError: null,
    };
    state.watches = state.watches.filter(x => x.id !== w.id).concat(w);
    save(state);
    statusEl.className='ok';
    statusEl.textContent = `Added: ${w.name} (${w.program}) ${platform}${maxBin?` ≤ ${fmt(maxBin)}`:''}`;
    log(`Added: ${w.name} (${w.program}) ${platform}${maxBin?` ≤ ${fmt(maxBin)}`:''}`);
    render();
    ensureNotificationPermission();
  }

  // ---------- boot ----------
  (function boot() {
    if (!document.body) { setTimeout(boot, 200); return; }
    render();
    log(`Loaded · ${state.watches.length} watch(es). Polling every ${POLL_MS/1000}s while this tab is open.`);
    startPolling();
  })();
})();
