// Generate sortable versions of the 96-97 OVR card list:
//   - 96-97-cards.csv  — opens in Excel / Sheets; sort via Data → Filter
//   - 96-97-cards.html — open in browser; click column headers to sort

const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/mcros/mutgg-alerts/96-97-cards.json', 'utf8'));

// ---------- CSV ----------
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const csvHeader = ['OVR','First Name','Last Name','Program','Position','Archetype','External ID'];
const csvRows = data.map(c => {
  const [pos, arch] = (c.archetype || '').split(/\s*-\s*/);
  return [c.ovr, c.firstName, c.lastName, c.program, pos || '', arch || '', c.externalId];
});
fs.writeFileSync(
  'C:/Users/mcros/mutgg-alerts/96-97-cards.csv',
  '﻿' +   // BOM so Excel detects UTF-8 (apostrophes, etc.)
  csvHeader.join(',') + '\n' +
  csvRows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n'
);
console.log('Wrote 96-97-cards.csv (' + csvRows.length + ' rows)');

// ---------- Sortable HTML ----------
const rowsHtml = data.map(c => {
  const [pos, arch] = (c.archetype || '').split(/\s*-\s*/);
  return `<tr>
    <td data-sort="${c.ovr}">${c.ovr}</td>
    <td>${c.firstName} ${c.lastName}</td>
    <td>${c.program}</td>
    <td>${pos || ''}</td>
    <td>${arch || ''}</td>
    <td><a href="https://www.mut.gg/players/?search=${encodeURIComponent(c.lastName)}" target="_blank">${c.externalId}</a></td>
  </tr>`;
}).join('');

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>96-97 OVR Cards (PC) — Sortable</title>
<style>
:root { color-scheme: light; }
body { font: 14px/1.4 system-ui, sans-serif; max-width: 1200px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; }
h1 { font-size: 20px; margin: 0 0 6px; }
p { color: #555; margin: 0 0 16px; }
input[type="search"] { padding: 8px 10px; width: 100%; max-width: 320px; border: 1px solid #ccc; border-radius: 6px; font: inherit; margin-bottom: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 10px; border-bottom: 1px solid #eee; text-align: left; }
th { background: #f5f5f5; cursor: pointer; user-select: none; position: sticky; top: 0; }
th:hover { background: #e8e8e8; }
th.sorted-asc::after  { content: " ↑"; color: #007acc; }
th.sorted-desc::after { content: " ↓"; color: #007acc; }
tr:nth-child(even) { background: #fafafa; }
tr:hover { background: #f0f8ff; }
.count { color: #555; font-size: 12px; margin-bottom: 12px; }
a { color: #0066cc; text-decoration: none; }
a:hover { text-decoration: underline; }
</style>
</head><body>

<h1>96-97 OVR Auctionable Cards (PC)</h1>
<p>Scraped from mut.gg. Click a column header to sort. Type in the box to filter. Click an External ID to search the player on mut.gg.</p>

<input id="filter" type="search" placeholder="Filter by name, program, position…">
<div class="count" id="count">${data.length} cards</div>

<table id="cards">
  <thead>
    <tr>
      <th data-sort-key="ovr" data-num="1">OVR</th>
      <th data-sort-key="name">Name</th>
      <th data-sort-key="program">Program</th>
      <th data-sort-key="position">Position</th>
      <th data-sort-key="archetype">Archetype</th>
      <th data-sort-key="externalId" data-num="1">External ID</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>

<script>
const table = document.getElementById('cards');
const tbody = table.tBodies[0];
const filter = document.getElementById('filter');
const count = document.getElementById('count');
let sortState = { col: 0, asc: false };

function applyFilter() {
  const q = filter.value.trim().toLowerCase();
  let shown = 0;
  for (const row of tbody.rows) {
    const match = !q || [...row.cells].some(c => c.textContent.toLowerCase().includes(q));
    row.style.display = match ? '' : 'none';
    if (match) shown++;
  }
  count.textContent = shown + ' card' + (shown === 1 ? '' : 's') + ' (of ${data.length} total)';
}
filter.addEventListener('input', applyFilter);

function sortBy(colIdx) {
  const isNum = !!table.tHead.rows[0].cells[colIdx].dataset.num;
  const asc = sortState.col === colIdx ? !sortState.asc : true;
  sortState = { col: colIdx, asc };
  for (const th of table.tHead.rows[0].cells) th.classList.remove('sorted-asc', 'sorted-desc');
  table.tHead.rows[0].cells[colIdx].classList.add(asc ? 'sorted-asc' : 'sorted-desc');
  const rows = [...tbody.rows];
  rows.sort((a, b) => {
    let av = a.cells[colIdx].dataset.sort ?? a.cells[colIdx].textContent.trim();
    let bv = b.cells[colIdx].dataset.sort ?? b.cells[colIdx].textContent.trim();
    if (isNum) { av = Number(av); bv = Number(bv); }
    if (av < bv) return asc ? -1 : 1;
    if (av > bv) return asc ? 1 : -1;
    return 0;
  });
  for (const r of rows) tbody.appendChild(r);
}
for (const th of table.tHead.rows[0].cells) {
  const i = th.cellIndex;
  th.addEventListener('click', () => sortBy(i));
}
// Default sort: OVR descending
sortBy(0); sortBy(0);  // toggle once to land on desc
</script>
</body></html>`;

fs.writeFileSync('C:/Users/mcros/mutgg-alerts/96-97-cards.html', html);
console.log('Wrote 96-97-cards.html (' + (html.length / 1024 | 0) + ' KB)');
