// Build the bookmarklet form and a draggable install.html from the userscript.
// Usage: node build-bookmarklet.js

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC  = path.join(ROOT, 'mutgg-alerts.user.js');
const OUT_BM = path.join(ROOT, 'mutgg-alerts.bookmarklet.txt');
const OUT_HTML = path.join(ROOT, 'install.html');

const src = fs.readFileSync(SRC, 'utf8');

// Strip Tampermonkey header (everything up to and including the closing "// ==/UserScript==" line).
const body = src.replace(/^[\s\S]*?\/\/ ==\/UserScript==\s*\n/, '').trim();

// Bookmarklet must be a single javascript: URI. We percent-encode the body.
const bm = 'javascript:' + encodeURIComponent('(function(){' + body + '})();').replace(/'/g, '%27');

fs.writeFileSync(OUT_BM, bm);
console.log(`Wrote ${OUT_BM} (${bm.length} chars)`);

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>MUT.GG Auction Alerts — Install</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0f1418; color:#e7e9ea; font:15px/1.5 system-ui,sans-serif; max-width:720px; margin:40px auto; padding:0 20px; }
  h1 { font-size:22px; margin-bottom:6px; }
  h2 { font-size:17px; margin-top:24px; }
  .lede { color:#9aa3ad; margin-bottom:24px; }
  .drag {
    display:inline-block; padding:10px 16px; background:#5865F2; color:#fff;
    border:1px solid #4752C4; border-radius:8px; text-decoration:none; font-weight:600;
    margin: 8px 0;
  }
  .drag:hover { background:#4752C4; }
  code, pre { background:#1a2229; color:#e7e9ea; padding:2px 5px; border-radius:4px; font:13px ui-monospace, monospace; }
  pre { padding:10px; overflow:auto; max-height:240px; white-space:pre-wrap; word-break:break-all; }
  ol li, ul li { margin-bottom:6px; }
  .warn { background:#3a2a17; border:1px solid #6b4a1f; padding:10px 12px; border-radius:6px; margin:18px 0; }
  .step { background:#13191e; border:1px solid #283139; border-radius:6px; padding:10px 14px; margin:12px 0; }
</style>
</head><body>
<h1>🔔 MUT.GG Auction Alerts</h1>
<p class="lede">Bookmarklet that watches MUT.GG and pings a Discord channel when a player you're watching gets a live auction at or below your price. Discord on your phone handles the push notification.</p>

<div class="step">
  <h2 style="margin-top:0">1. Install the bookmark</h2>
  <ol>
    <li>Show your bookmarks bar — <code>Ctrl+Shift+B</code> (Windows) or <code>⌘+Shift+B</code> (Mac).</li>
    <li>Drag this button up to the bar:
      <br><a class="drag" href="${bm.replace(/"/g, '&quot;')}">MUT.GG Auction Alerts</a></li>
  </ol>
</div>

<div class="step">
  <h2 style="margin-top:0">2. Set up the Discord webhook (one time)</h2>
  <ol>
    <li>In Discord, pick the channel you want alerts in (private server is fine — 30 seconds to make one).</li>
    <li>Right-click the channel → <strong>Edit Channel</strong> → <strong>Integrations</strong> → <strong>Webhooks</strong> → <strong>New Webhook</strong>.</li>
    <li>Click <strong>Copy Webhook URL</strong>.</li>
    <li>Open <a href="https://www.mut.gg/" target="_blank">mut.gg</a>, click your new bookmark, expand <strong>⚙️ Alert delivery</strong>, paste the URL into <em>Discord URL</em>, hit <strong>Save</strong>, then <strong>Test</strong>. A test message should land in your Discord channel almost instantly.</li>
    <li>On your phone, enable Discord notifications for that channel (long-press the channel → Notifications → All Messages).</li>
  </ol>
</div>

<div class="step">
  <h2 style="margin-top:0">3. Add a watch</h2>
  <p>On any mut.gg page, click the bookmark and fill the form:</p>
  <ul>
    <li><strong>Player</strong> — full name, e.g. <code>Tyreek Hill</code></li>
    <li><strong>Program</strong> — partial match works, e.g. <code>Sugar Rush</code></li>
    <li><strong>Platform</strong> — PC / Xbox Series X / PlayStation 5</li>
    <li><strong>Alert ≤</strong> — price ceiling in coins (e.g. <code>400000</code>). Leave blank to alert on any new listing for that player+program.</li>
  </ul>
  <p>Hit <strong>Add watch</strong>. The panel polls mut.gg every ~2.5 minutes while your mut.gg tab is open. When a matching listing appears, Discord pings → your phone notifies.</p>
</div>

<div class="warn">
  <strong>Keep a mut.gg tab open.</strong> The bookmarklet runs inside that tab — pin one in the background and it polls forever. Close all mut.gg tabs and polling stops until you click the bookmark again.
</div>

<h2>Share with others</h2>
<p>The bookmark above is everything. To share without this page, copy this string and tell people to paste it as the URL of a new manually-created bookmark:</p>
<pre id="bm-raw">${bm.replace(/</g,'&lt;')}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('bm-raw').textContent);this.textContent='Copied'">Copy bookmarklet</button>

<h2>Tampermonkey alternative</h2>
<p>If you have Tampermonkey/Violentmonkey installed, you can use <code>mutgg-alerts.user.js</code> instead — it auto-runs on every mut.gg page so you never click the bookmark.</p>

<h2>ntfy.sh alternative (no Discord)</h2>
<p>The panel also supports <a href="https://ntfy.sh" target="_blank">ntfy.sh</a> push — install their phone app, pick a hard-to-guess topic, subscribe in the app, paste the same topic in the panel. No account needed.</p>
</body></html>`;

fs.writeFileSync(OUT_HTML, html);
console.log(`Wrote ${OUT_HTML} (${html.length} chars)`);
