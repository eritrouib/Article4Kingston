(function () {
'use strict';

const {
  parseQuery, geocode, checkLocation, fetchArticle4Areas, fetchArticle4Directions,
  GROUPS, entityUrl, detectColumns, rowToQuery, resultToRow, latLonToBng, sleep,
  PLANNING_API, KINGSTON_BBOX,
} = window.A4Lookup;

/* global L, proj4, Papa */

const state = {
  boundary: null,
  legacyA4: null,
  a4Areas: null,
  a4Directions: {},
  nearMetres: 25,
  layers: {},
  marker: null,
  batch: { rows: [], cols: null, headers: [], results: [], cancelled: false, running: false },
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Nominatim allows one request per second; share a throttle across single and batch use.
let lastNominatim = 0;
async function nominatimThrottle() {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = L.map('map', { zoomControl: true, preferCanvas: false }).setView([51.385, -0.29], 12);

const basemaps = {
  'Streets (grey)': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20, attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }),
  'Aerial': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Imagery &copy; Esri',
  }),
};
basemaps['Streets (grey)'].addTo(map);
const layerControl = L.control.layers(basemaps, {}, { collapsed: true }).addTo(map);

const styles = {
  a4: { color: '#b45309', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.25 },
  a4Legacy: { color: '#7c3aed', weight: 2, dashArray: '6 4', fillOpacity: 0.08 },
  ca: { color: '#0f766e', weight: 1.5, fillColor: '#14b8a6', fillOpacity: 0.15 },
  boundary: { color: '#1e3a5f', weight: 2.5, fill: false, dashArray: '2 6', lineCap: 'round' },
  highlight: { color: '#dc2626', weight: 4, fillOpacity: 0.3 },
};

function popupFor(props, kind) {
  const p = props || {};
  const name = esc(p.name || p.reference || kind);
  const parts = [`<strong>${name}</strong>`, `<span class="muted">${esc(kind)}</span>`];
  if (p['article-4-direction']) parts.push(`Direction: ${esc(directionLabel(p['article-4-direction']))}`);
  if (p['start-date']) parts.push(`From ${esc(p['start-date'])}`);
  if (p.entity) parts.push(`<a href="${entityUrl(p.entity)}" target="_blank" rel="noopener">View record</a>`);
  return parts.join('<br>');
}

function directionLabel(ref) {
  const d = state.a4Directions[ref];
  return d ? `${ref} – ${d.name}` : ref;
}

// Bundled data (js/data.js) is used when present, so the page works from file://.
async function loadLocal(key, url) {
  if (window.A4_DATA && window.A4_DATA[key]) return window.A4_DATA[key];
  return loadJson(url);
}

async function loadJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function init() {
  setStatus('Loading planning data…', 'loading');
  try {
    state.boundary = await loadLocal('boundary', 'data/kingston-boundary.geojson');
    state.layers.boundary = L.geoJSON(state.boundary, { style: styles.boundary, interactive: false }).addTo(map);
    layerControl.addOverlay(state.layers.boundary, 'Borough boundary');
    map.fitBounds(state.layers.boundary.getBounds(), { padding: [10, 10] });
  } catch (e) { console.warn('boundary', e); }

  try {
    state.legacyA4 = await loadLocal('legacyA4', 'data/article4-legacy-2022.geojson');
    state.layers.legacy = L.geoJSON(state.legacyA4, {
      style: styles.a4Legacy,
      onEachFeature: (f, l) => l.bindPopup(popupFor(f.properties, 'Article 4 (2022 copy from this repo)')),
    });
    layerControl.addOverlay(state.layers.legacy, 'Article 4 – 2022 offline copy');
  } catch (e) { console.warn('legacy', e); }

  const [areas, dirs] = await Promise.allSettled([fetchArticle4Areas(fetch), fetchArticle4Directions(fetch)]);
  if (dirs.status === 'fulfilled') state.a4Directions = dirs.value;
  renderDirectionsList();

  if (areas.status === 'fulfilled' && areas.value.features.length) {
    state.a4Areas = areas.value;
    state.layers.a4 = L.geoJSON(state.a4Areas, {
      style: styles.a4,
      onEachFeature: (f, l) => l.bindPopup(popupFor(f.properties, 'Article 4 direction area')),
    }).addTo(map);
    layerControl.addOverlay(state.layers.a4, 'Article 4 areas (live)');
    const nd = Object.keys(state.a4Directions).length;
    setStatus(`Live data: ${state.a4Areas.features.length} Article 4 areas · ${nd} direction${nd === 1 ? '' : 's'}`, 'ok');
  } else {
    if (state.layers.legacy) state.layers.legacy.addTo(map);
    setStatus('Planning Data unreachable — using 2022 offline copy for Article 4 only', 'warn');
  }

  loadConservationAreas();
  bootFromUrl();
}

async function loadConservationAreas() {
  const [w, s, e, n] = KINGSTON_BBOX;
  const wkt = `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
  const url = `${PLANNING_API}/entity.geojson?dataset=conservation-area&geometry_relation=intersects&geometry=${encodeURIComponent(wkt)}&limit=500`;
  try {
    const fc = await loadJson(url);
    const today = new Date().toISOString().slice(0, 10);
    fc.features = (fc.features || []).filter((f) => f.geometry && !(f.properties['end-date'] && f.properties['end-date'] <= today));
    if (!fc.features.length) return;
    state.layers.ca = L.geoJSON(fc, {
      style: styles.ca,
      onEachFeature: (f, l) => l.bindPopup(popupFor(f.properties, 'Conservation area')),
    });
    layerControl.addOverlay(state.layers.ca, 'Conservation areas');
  } catch (e) { console.warn('conservation areas', e); }
}

function setStatus(text, kind) {
  const el = $('#data-status');
  el.textContent = text;
  el.dataset.kind = kind;
}

map.on('click', (ev) => {
  if (state.batch.running) return;
  switchTab('single');
  const { lat, lng } = ev.latlng;
  $('#q').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  runSingle($('#q').value);
});

function placeMarker(loc, result) {
  if (state.marker) state.marker.remove();
  const status = result ? result.article4.status : 'unknown';
  const color = result && result.article4.borderline ? '#c2410c' : status === 'inside' ? '#b45309' : status === 'outside' ? '#15803d' : '#475569';
  state.marker = L.circleMarker([loc.lat, loc.lon], {
    radius: 9, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1,
  }).addTo(map);
  if (state.circle) state.circle.remove();
  state.circle = L.circle([loc.lat, loc.lon], {
    radius: state.nearMetres, color, weight: 1, dashArray: '3 3', fill: false, interactive: false,
  }).addTo(map);
  state.marker.bindTooltip(esc(loc.label));
  map.setView([loc.lat, loc.lon], Math.max(map.getZoom(), 17));
}

// ---------------------------------------------------------------------------
// Single check
// ---------------------------------------------------------------------------
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSingle($('#q').value);
});

let singleToken = 0;
async function runSingle(text, chosenLoc) {
  const token = ++singleToken;
  const out = $('#result');
  out.innerHTML = '<div class="card loading"><span class="spinner"></span>Checking…</div>';
  try {
    const loc = chosenLoc || await geocode(parseQuery(text), { fetch, proj4, throttle: nominatimThrottle });
    if (loc.easting == null) Object.assign(loc, latLonToBng(proj4, loc.lat, loc.lon));
    if (token !== singleToken) return;
    placeMarker(loc, null);
    const result = await checkLocation(loc, deps());
    if (token !== singleToken) return;
    placeMarker(loc, result);
    out.innerHTML = renderResult(result);
    wireResult(out, result);
    history.replaceState(null, '', `#q=${encodeURIComponent(text)}`);
  } catch (e) {
    if (token !== singleToken) return;
    out.innerHTML = `<div class="card error"><strong>Couldn't check that location.</strong><p>${esc(e.message)}</p></div>`;
  }
}

function deps() {
  return {
    fetch, a4Areas: state.a4Areas, a4Directions: state.a4Directions,
    legacyA4: state.legacyA4, boundary: state.boundary, nearMetres: state.nearMetres,
  };
}

function verdict(r) {
  const a4 = r.article4;
  if (a4.status === 'inside') {
    return { cls: a4.borderline ? 'v-border' : 'v-in', title: a4.borderline ? 'Inside an Article 4 area — near the boundary' : 'Inside an Article 4 direction area' };
  }
  if (a4.status === 'outside') {
    return { cls: a4.borderline ? 'v-border' : 'v-out', title: a4.borderline ? 'Outside, but an Article 4 boundary is very close' : 'Not in an Article 4 direction area' };
  }
  return { cls: 'v-unknown', title: 'Article 4 status could not be determined' };
}

function renderResult(r) {
  const v = verdict(r);
  const loc = r.location;
  const a4 = r.article4;
  const methodNote = {
    live: 'Checked live against planning.data.gov.uk',
    offline: 'Checked against downloaded Article 4 boundaries (live point query failed)',
    'offline-legacy': 'Checked against the 2022 copy held in this repository (offline)',
  }[a4.method] || '';

  const dirHtml = a4.directions.length ? `
    <ul class="dir-list">${a4.directions.map((d) => `
      <li><strong>${esc(d.reference)}</strong> ${esc(d.name && d.name !== d.reference ? d.name : '')}
        ${d.startDate ? `<span class="muted">· in force from ${esc(d.startDate)}</span>` : ''}
        ${d.entity ? `· <a href="${entityUrl(d.entity)}" target="_blank" rel="noopener">record</a>` : ''}
        ${d.documentUrl ? `· <a href="${esc(d.documentUrl)}" target="_blank" rel="noopener">direction document</a>` : ''}
        ${d.description ? `<div class="muted small">${esc(d.description)}</div>` : ''}
      </li>`).join('')}</ul>` : '';

  const areaHtml = a4.areas.length ? `<p class="small">Area${a4.areas.length > 1 ? 's' : ''}: ${a4.areas.map((a) =>
    `${a.entity ? `<a href="${entityUrl(a.entity)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)}${a.distanceToEdge != null ? ` <span class="muted">(${Math.round(a.distanceToEdge)} m from edge)</span>` : ''}`).join(', ')}</p>` : '';
  const nearA4 = a4.status === 'outside' && a4.near.length ? `<p class="small">Nearby: ${a4.near.map((a) =>
    `${esc(a.name)}${a.distance != null ? ` (${Math.round(a.distance)} m)` : ''}`).join(', ')}</p>` : '';

  // Designations grouped
  const groups = {};
  for (const d of r.designations) (groups[d.group] ||= []).push(d);
  const order = ['heritage', 'trees', 'flood', 'land', 'nature', 'policy', 'other'];
  const desigHtml = order.filter((g) => groups[g]).map((g) => `
    <div class="group"><h4>${esc(GROUPS[g])}</h4><ul>${groups[g].map(designationItem).join('')}</ul></div>`).join('');
  const adminHtml = groups.admin ? `<details class="admin"><summary>Administrative areas (${groups.admin.length})</summary><ul>${groups.admin.map(designationItem).join('')}</ul></details>` : '';
  const noneFound = r.dataSource && !desigHtml ? '<p class="muted small">No other designations recorded at this point.</p>' : '';
  const notChecked = !r.dataSource ? '<p class="muted small">Other designations were not checked (live data unavailable).</p>' : '';

  const nearbyRelevant = r.nearby.filter((d) => d.group !== 'admin');
  const nearbyHtml = nearbyRelevant.length ? `
    <details class="nearby" ${nearbyRelevant.some((d) => d.dataset === 'listed-building' || d.group === 'trees') ? 'open' : ''}>
      <summary>Within ${state.nearMetres} m but not at the point (${nearbyRelevant.length})</summary>
      <ul>${nearbyRelevant.map(designationItem).join('')}</ul>
    </details>` : '';

  const warnHtml = r.warnings.length ? `<ul class="warnings">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
  const alts = loc.alternatives && loc.alternatives.length ? `
    <details class="alts"><summary>Not the right place? ${loc.alternatives.length} other match${loc.alternatives.length > 1 ? 'es' : ''}</summary>
      <ul>${loc.alternatives.map((a, i) => `<li><button class="linkish" data-alt="${i}">${esc(a.label)}</button></li>`).join('')}</ul></details>` : '';

  return `
  <article class="card result">
    <div class="verdict ${v.cls}">
      <div class="verdict-title">${esc(v.title)}</div>
      ${methodNote ? `<div class="verdict-sub">${esc(methodNote)}</div>` : ''}
    </div>
    <dl class="loc">
      <dt>Location</dt><dd>${esc(loc.label)}</dd>
      <dt>Found by</dt><dd>${esc(loc.source)} <span class="pill pill-${esc(loc.precision)}">${esc(precisionLabel(loc.precision))}</span></dd>
      <dt>Grid ref</dt><dd>${loc.easting != null ? `E ${esc(loc.easting)}, N ${esc(loc.northing)}` : '–'} <span class="muted">· ${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}</span></dd>
      <dt>Borough</dt><dd>${r.insideKingston === true ? 'Kingston upon Thames' : r.insideKingston === false ? '<strong>Outside Kingston</strong>' : '–'}</dd>
    </dl>
    ${alts}
    ${warnHtml}
    ${a4.status === 'inside' || a4.near.length ? `<section><h3>Article 4</h3>${dirHtml}${areaHtml}${nearA4}</section>` : ''}
    <section><h3>Other designations at this point</h3>${desigHtml}${noneFound}${notChecked}${adminHtml}</section>
    ${nearbyHtml}
    <footer class="result-foot">
      <span class="muted small">Checked ${new Date(r.checkedAt).toLocaleString('en-GB')}${r.dataSource ? ` · ${esc(r.dataSource)}` : ''}</span>
      <span class="actions">
        <button class="btn btn-small" data-act="copy">Copy summary</button>
        <button class="btn btn-small" data-act="print">Print</button>
      </span>
    </footer>
  </article>`;
}

function precisionLabel(p) {
  return { exact: 'exact point', address: 'building match', street: 'street-level match', postcode: 'postcode centre' }[p] || p;
}

function designationItem(d) {
  const extra = [d.grade && `Grade ${d.grade}`, d.level && `Level ${d.level}`, d.startDate && `from ${d.startDate}`].filter(Boolean).join(' · ');
  return `<li><span class="tag">${esc(d.label)}</span> ${d.entity ? `<a href="${entityUrl(d.entity)}" target="_blank" rel="noopener">${esc(d.name || d.reference)}</a>` : esc(d.name)}
    ${extra ? `<span class="muted small">${esc(extra)}</span>` : ''}
    ${d.documentUrl ? `<a class="small" href="${esc(d.documentUrl)}" target="_blank" rel="noopener">document</a>` : ''}</li>`;
}

function wireResult(el, r) {
  el.querySelector('[data-act="copy"]')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(summaryText(r));
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy summary'; }, 1500);
    } catch { e.target.textContent = 'Copy failed'; }
  });
  el.querySelector('[data-act="print"]')?.addEventListener('click', () => window.print());
  el.querySelectorAll('[data-alt]').forEach((b) => b.addEventListener('click', () => {
    const a = r.location.alternatives[+b.dataset.alt];
    runSingle($('#q').value, { ...a, source: 'Address match (OpenStreetMap)', precision: 'street', warnings: ['Alternative address match chosen manually.'] });
  }));
}

function summaryText(r) {
  const row = resultToRow(r);
  const lines = [
    `Location: ${row.matched_location}`,
    `Grid ref: E ${row.easting} N ${row.northing} (${precisionLabel(r.location.precision)})`,
    `Article 4: ${row.article4 === 'Y' ? 'YES' : row.article4 === 'N' ? 'No' : 'Unknown'}${row.article4_borderline === 'Y' ? ' (borderline – verify)' : ''}`,
  ];
  if (row.article4_directions) lines.push(`  Direction(s): ${row.article4_directions}`);
  if (row.article4_areas) lines.push(`  Area(s): ${row.article4_areas}`);
  const add = (k, v) => v && lines.push(`${k}: ${v}`);
  add('Conservation area', row.conservation_area);
  add('Listed building', row.listed_building_at_point);
  add('Listed buildings nearby', row.listed_buildings_nearby);
  add('Tree preservation', row.tree_preservation);
  add('Flood risk', row.flood_risk);
  add('Green belt / open land', row.green_belt_open_land);
  add('Other heritage', row.heritage_other);
  add('Nature / environment', row.nature_environment);
  add('Plans / sites', row.plans_policy_sites);
  add('Other', row.other_designations);
  add('Notes', row.warnings);
  lines.push(`Checked: ${new Date(r.checkedAt).toLocaleString('en-GB')} via ${row.data_source}`);
  return lines.join('\n');
}

function bootFromUrl() {
  const m = location.hash.match(/q=([^&]+)/);
  if (m) {
    const q = decodeURIComponent(m[1]);
    $('#q').value = q;
    runSingle(q);
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tabpanel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

function renderDirectionsList() {
  const el = $('#directions-list');
  const dirs = Object.values(state.a4Directions).sort((a, b) => String(a.reference).localeCompare(String(b.reference)));
  if (!dirs.length) {
    el.innerHTML = '<p class="muted">Could not load the list of directions from Planning Data.</p>';
    return;
  }
  el.innerHTML = `<ul>${dirs.map((d) => `<li><strong>${esc(d.reference)}</strong> ${esc(d.name)}
    ${d['start-date'] ? `<span class="muted">· from ${esc(d['start-date'])}</span>` : ''}
    ${d['end-date'] ? `<span class="muted">· ended ${esc(d['end-date'])}</span>` : ''}
    · <a href="${entityUrl(d.entity)}" target="_blank" rel="noopener">record</a></li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------
$('#near-metres').addEventListener('change', (e) => { state.nearMetres = +e.target.value; });

$('#batch-template').addEventListener('click', () => {
  const csv = Papa.unparse([
    { reference: 'LLC/0001', uprn: '', address: '', postcode: '', easting: '518010', northing: '169150' },
    { reference: 'LLC/0002', uprn: '', address: '1 Example Road, Surbiton', postcode: 'KT6 4AA', easting: '', northing: '' },
    { reference: 'LLC/0003', uprn: '', address: '', postcode: 'KT1 1EU', easting: '', northing: '' },
  ]);
  download('article4-batch-template.csv', csv);
});

$('#csv-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true, skipEmptyLines: 'greedy',
    complete: ({ data, meta }) => {
      const cols = detectColumns(meta.fields || []);
      Object.assign(state.batch, { rows: data, headers: meta.fields || [], cols, results: [] });
      const used = [
        cols.easting && cols.northing && `Easting/Northing (${cols.easting}, ${cols.northing})`,
        cols.lat && cols.lon && `Lat/Lon (${cols.lat}, ${cols.lon})`,
        cols.address && `Address (${cols.address})`,
        cols.addressParts && `Address parts (${cols.addressParts.join(', ')})`,
        cols.postcode && `Postcode (${cols.postcode})`,
        cols.query && `Query (${cols.query})`,
      ].filter(Boolean);
      const types = data.map((r) => rowToQuery(r, cols).type);
      const count = (t) => types.filter((x) => x === t).length;
      const addrRows = count('address');
      const mins = Math.ceil((addrRows * 1.2 + data.length * 0.6) / 60);
      $('#batch-info').innerHTML = used.length ? `
        <div class="card">
          <p><strong>${data.length}</strong> rows in <em>${esc(file.name)}</em>. Using: ${esc(used.join(' · '))}</p>
          <p class="small">${count('bng') + count('latlon')} by coordinates · ${addrRows} by address · ${count('postcode')} by postcode centre${count('empty') ? ` · <strong>${count('empty')} with no usable location</strong>` : ''}</p>
          <p class="muted small">Estimated time: about ${mins} minute${mins === 1 ? '' : 's'}. Keep this tab open.</p>
        </div>` : `<div class="card error">No location columns recognised. Columns found: ${esc((meta.fields || []).join(', '))}. Add an Address, Postcode or Easting/Northing column.</div>`;
      $('#batch-run').hidden = !used.length;
      $('#batch-download').hidden = true;
      $('#batch-summary').innerHTML = '';
      $('#batch-progress').value = 0;
      $('#batch-count').textContent = '';
    },
    error: (err) => { $('#batch-info').innerHTML = `<div class="card error">Couldn't read CSV: ${esc(err.message)}</div>`; },
  });
});

$('#batch-start').addEventListener('click', runBatch);
$('#batch-cancel').addEventListener('click', () => { state.batch.cancelled = true; });
$('#batch-download').addEventListener('click', () => {
  const name = `article4-results-${new Date().toISOString().slice(0, 10)}.csv`;
  download(name, Papa.unparse(state.batch.results));
});

async function runBatch() {
  const b = state.batch;
  b.cancelled = false;
  b.running = true;
  b.results = [];
  $('#batch-start').hidden = true;
  $('#batch-cancel').hidden = false;
  $('#batch-download').hidden = true;
  const prog = $('#batch-progress');
  prog.max = b.rows.length;
  const tally = { inside: 0, outside: 0, borderline: 0, error: 0 };
  const batchLayer = L.layerGroup().addTo(map);
  if (state.layers.batch) state.layers.batch.remove();
  state.layers.batch = batchLayer;

  for (let i = 0; i < b.rows.length && !b.cancelled; i++) {
    const row = b.rows[i];
    const q = rowToQuery(row, b.cols);
    let out;
    try {
      if (q.type === 'empty') throw new Error('No usable location in this row');
      const loc = await geocode(q, { fetch, proj4, throttle: nominatimThrottle });
      if (loc.easting == null) Object.assign(loc, latLonToBng(proj4, loc.lat, loc.lon));
      const r = await checkLocation(loc, deps());
      out = { ...row, ...resultToRow(r), error: '' };
      const st = r.article4.borderline ? 'borderline' : r.article4.status;
      if (tally[st] != null) tally[st]++;
      const color = st === 'borderline' ? '#c2410c' : st === 'inside' ? '#b45309' : '#15803d';
      L.circleMarker([loc.lat, loc.lon], { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
        .bindPopup(`<strong>${esc(loc.label)}</strong><br>Article 4: ${esc(out.article4 || '?')}${out.article4_borderline === 'Y' ? ' (borderline)' : ''}`)
        .addTo(batchLayer);
    } catch (e) {
      tally.error++;
      out = { ...row, error: e.message, checked_at: new Date().toISOString() };
    }
    b.results.push(out);
    prog.value = i + 1;
    $('#batch-count').textContent = `${i + 1} / ${b.rows.length}`;
    if (q.type !== 'address') await sleep(150); // be polite to the APIs
  }

  b.running = false;
  $('#batch-start').hidden = false;
  $('#batch-cancel').hidden = true;
  $('#batch-download').hidden = !b.results.length;
  if (batchLayer.getLayers().length) map.fitBounds(L.featureGroup(batchLayer.getLayers()).getBounds(), { padding: [30, 30], maxZoom: 16 });
  $('#batch-summary').innerHTML = `
    <div class="card">
      <p><strong>${b.cancelled ? 'Stopped' : 'Done'}.</strong> ${b.results.length} of ${b.rows.length} rows checked.</p>
      <div class="tally">
        <span class="t t-in">${tally.inside} inside Article 4</span>
        <span class="t t-out">${tally.outside} outside</span>
        <span class="t t-border">${tally.borderline} borderline – verify</span>
        <span class="t t-err">${tally.error} not found</span>
      </div>
    </div>`;
}

function download(name, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }); // BOM so Excel reads UTF-8
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

init();
})();
