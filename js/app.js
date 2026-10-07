(function () {
'use strict';

const {
  parseQuery, geocode, checkLocation, fetchArticle4Areas, fetchArticle4Directions,
  GROUPS, entityUrl, detectColumns, rowToQuery, resultToRow, latLonToBng, sleep,
  PLANNING_API, KINGSTON_BBOX, linkDirection,
} = window.A4Lookup;

const STATUS_TEXT = {
  yes: 'Yes', plot: 'Part of plot', near: 'Nearby', no: 'No',
  not_published: 'Not published here', unknown: 'Not confirmed', unchecked: 'Not checked',
};

/* global L, proj4, Papa */

const state = {
  boundary: null,
  offlineA4: null,
  legacyA4: null,
  a4Areas: null,
  a4Directions: {},
  nearMetres: 25,
  coverageCache: new Map(),
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

// All background maps here are free to use without an API key. (CARTO's
// basemaps were dropped: since Aug 2026 they stamp "API KEY REQUIRED" on tiles.)
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const DEFAULT_BASEMAP = 'Light grey (Esri)';
const basemaps = {
  'Light grey (Esri)': L.tileLayer(`${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 19, maxNativeZoom: 16, attribution: 'Basemap &copy; Esri',
  }),
  'Streets (grey)': L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR, className: 'tiles-grey' }),
  'Streets (colour)': L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }),
  'Aerial (Esri)': L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  }),
};
basemaps[DEFAULT_BASEMAP].addTo(map);
const layerControl = L.control.layers(basemaps, {}, { collapsed: true }).addTo(map);

// If the current background map fails to load (provider down, or blocked on
// this network), switch once to another provider so the map isn't blank.
(function basemapFallback() {
  const fallbackOrder = ['Light grey (Esri)', 'Streets (grey)', 'Aerial (Esri)'];
  const tried = new Set();
  let current = DEFAULT_BASEMAP;
  for (const [name, layer] of Object.entries(basemaps)) {
    let errors = 0;
    let loaded = 0;
    layer.on('add', () => { current = name; errors = 0; loaded = 0; });
    layer.on('tileload', () => { loaded++; });
    layer.on('tileerror', () => {
      errors++;
      if (current !== name || loaded > 0 || errors < 4) return;
      tried.add(name);
      const next = fallbackOrder.find((n) => n !== name && !tried.has(n));
      if (!next) return;
      map.removeLayer(layer);
      basemaps[next].addTo(map);
      console.warn(`Background map "${name}" failed to load; switched to "${next}".`);
    });
  }
})();

const styles = {
  a4: { color: '#b45309', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.25 },
  a4Legacy: { color: '#7c3aed', weight: 2, dashArray: '6 4', fillOpacity: 0.08 },
  ca: { color: '#0f766e', weight: 1.5, fillColor: '#14b8a6', fillOpacity: 0.15 },
  boundary: { color: '#1e3a5f', weight: 2.5, fill: false, dashArray: '2 6', lineCap: 'round' },
  highlight: { color: '#dc2626', weight: 4, fillOpacity: 0.3 },
  plot: { color: '#7c3aed', weight: 3, fillColor: '#8b5cf6', fillOpacity: 0.12, dashArray: '6 4' },
};

function popupFor(props, kind) {
  const p = props || {};
  const name = esc(p.name || p.reference || kind);
  const parts = [`<strong>${name}</strong>`, `<span class="muted">${esc(kind)}</span>`];
  if (p['article-4-direction'] || p.notes) {
    const label = directionLabel({ direction: p['article-4-direction'], notes: p.notes, name: p.name });
    if (label) parts.push(`Direction: ${esc(label)}`);
  }
  if (p['permitted-development-rights']) parts.push(`<span class="small">${esc(p['permitted-development-rights'])}</span>`);
  if (p['start-date']) parts.push(`From ${esc(p['start-date'])}`);
  if (p.entity) parts.push(`<a href="${entityUrl(p.entity)}" target="_blank" rel="noopener">View record</a>`);
  return parts.join('<br>');
}

function directionLabel(area) {
  const { ref } = linkDirection(area, state.a4Directions);
  if (ref) return `${ref} – ${state.a4Directions[ref].name}`;
  return area.notes || '';
}

// Bundled data (js/data.js) is used when present, so the page works from file://.
// js/data.js is the complete list of local data, so a missing key means "not saved yet".
async function loadLocal(key, url) {
  if (window.A4_DATA) return window.A4_DATA[key] || null;
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

  // Saved copy of the official boundaries (made by scripts/update_offline_data.py).
  try {
    state.offlineA4 = await loadLocal('offlineA4', 'data/article4-official.geojson');
  } catch (e) { state.offlineA4 = null; }
  const haveSnapshot = !!(state.offlineA4 && state.offlineA4.features && state.offlineA4.features.length);
  const savedOn = haveSnapshot && state.offlineA4.metadata ? String(state.offlineA4.metadata.downloaded || '').slice(0, 10) : '';

  // Hand-digitised 2022 polygons: last resort only, if no official copy has been saved yet.
  if (!haveSnapshot) {
    try {
      state.legacyA4 = await loadLocal('legacyA4', 'data/article4-legacy-2022.geojson');
    } catch (e) { console.warn('legacy', e); }
  }

  const [areas, dirs] = await Promise.allSettled([fetchArticle4Areas(fetch), fetchArticle4Directions(fetch)]);
  if (dirs.status === 'fulfilled' && Object.keys(dirs.value).length) state.a4Directions = dirs.value;
  else if (haveSnapshot && state.offlineA4.directions) state.a4Directions = state.offlineA4.directions;
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
  } else if (haveSnapshot) {
    state.layers.a4 = L.geoJSON(state.offlineA4, {
      style: styles.a4,
      onEachFeature: (f, l) => l.bindPopup(popupFor(f.properties, `Article 4 direction area (saved ${savedOn})`)),
    }).addTo(map);
    layerControl.addOverlay(state.layers.a4, 'Article 4 areas (saved copy)');
    setStatus(`Planning Data unreachable — using saved official Article 4 boundaries${savedOn ? ` from ${savedOn}` : ''}`, 'warn');
  } else if (state.legacyA4) {
    state.layers.legacy = L.geoJSON(state.legacyA4, {
      style: styles.a4Legacy,
      onEachFeature: (f, l) => l.bindPopup(popupFor(f.properties, 'Article 4 (2022 copy from this repo)')),
    }).addTo(map);
    layerControl.addOverlay(state.layers.legacy, 'Article 4 – 2022 offline copy');
    setStatus('Planning Data unreachable — using 2022 offline copy for Article 4 only', 'warn');
  } else {
    setStatus('Planning Data unreachable — Article 4 can\'t be checked', 'warn');
  }

  setupOverlays();
  bootFromUrl();
}

// Optional map layers, loaded from Planning Data the first time they're switched on.
// They ask for "everything intersecting the borough" by its entity ID, so no shape
// has to be sent in the URL.
const KINGSTON_LAD_ENTITY = 8600304;
const OVERLAYS = [
  { name: 'Conservation areas', dataset: 'conservation-area', style: { color: '#0f766e', weight: 1.5, fillColor: '#14b8a6', fillOpacity: 0.15 } },
  { name: 'Listed buildings', dataset: 'listed-building', point: '#be123c' },
  { name: 'Listed building outlines', dataset: 'listed-building-outline', style: { color: '#be123c', weight: 1.5, fillColor: '#fb7185', fillOpacity: 0.3 }, minZoom: 15 },
  { name: 'Tree preservation areas', dataset: 'tree-preservation-zone', style: { color: '#15803d', weight: 1, fillColor: '#22c55e', fillOpacity: 0.18 }, minZoom: 15 },
  { name: 'Protected trees', dataset: 'tree', point: '#15803d', minZoom: 16 },
  { name: 'Archaeological priority areas', dataset: 'archaeological-priority-area', style: { color: '#92400e', weight: 1.5, dashArray: '4 3', fillColor: '#d97706', fillOpacity: 0.08 } },
  { name: 'Scheduled monuments', dataset: 'scheduled-monument', style: { color: '#7f1d1d', weight: 2, fillColor: '#b91c1c', fillOpacity: 0.25 } },
  { name: 'Green belt', dataset: 'green-belt', style: { color: '#3f6212', weight: 1, fillColor: '#84cc16', fillOpacity: 0.15 } },
  { name: 'Brownfield land', dataset: 'brownfield-land', style: { color: '#57534e', weight: 1.5, fillColor: '#a8a29e', fillOpacity: 0.3 } },
];

function setupOverlays() {
  for (const o of OVERLAYS) {
    const group = L.layerGroup();
    let loaded = false;
    group.on('add', async () => {
      if (loaded) return;
      loaded = true;
      const prev = $('#data-status').textContent;
      const kind = $('#data-status').dataset.kind;
      setStatus(`Loading ${o.name.toLowerCase()}…`, 'loading');
      try {
        const fc = await fetchBoroughLayer(o.dataset);
        const label = o.name.replace(/s$/, '');
        L.geoJSON(fc, {
          style: o.style,
          pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 4, color: '#fff', weight: 1, fillColor: o.point || '#334155', fillOpacity: 1 }),
          onEachFeature: (f, l) => l.bindPopup(popupFor(f.properties, label)),
        }).addTo(group);
        if (o.minZoom && map.getZoom() < o.minZoom && fc.features.length > 300) {
          setStatus(`${o.name}: ${fc.features.length} shown — zoom in to see them clearly`, kind);
          setTimeout(() => setStatus(prev, kind), 4000);
        } else {
          setStatus(prev, kind);
        }
      } catch (e) {
        loaded = false;
        console.warn(o.dataset, e);
        setStatus(`Couldn't load ${o.name.toLowerCase()} from Planning Data`, 'warn');
        setTimeout(() => setStatus(prev, kind), 4000);
      }
    });
    layerControl.addOverlay(group, o.name);
  }
}

async function fetchBoroughLayer(dataset) {
  const today = new Date().toISOString().slice(0, 10);
  const features = [];
  let url = `${PLANNING_API}/entity.geojson?dataset=${dataset}&geometry_entity=${KINGSTON_LAD_ENTITY}&geometry_relation=intersects&limit=500`;
  for (let page = 0; page < 30 && url; page++) {
    const data = await loadJson(url);
    const feats = data.features || [];
    // Guard against an ignored filter returning other datasets.
    features.push(...feats.filter((f) => f.geometry && (!f.properties.dataset || f.properties.dataset === dataset)
      && !(f.properties['end-date'] && f.properties['end-date'] <= today)));
    const next = data.links && data.links.next;
    url = next && feats.length ? (next.startsWith('http') ? next : PLANNING_API + next) : null;
  }
  return { type: 'FeatureCollection', features };
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
  if (state.plotLayer) { state.plotLayer.remove(); state.plotLayer = null; }
  const status = result ? result.article4.status : 'unknown';
  const color = result && result.article4.borderline ? '#c2410c' : status === 'inside' ? '#b45309' : status === 'outside' ? '#15803d' : '#475569';
  if (result && result.plot && result.plot.geometry) {
    state.plotLayer = L.geoJSON(result.plot.geometry, { style: styles.plot, interactive: false }).addTo(map);
  }
  state.marker = L.circleMarker([loc.lat, loc.lon], {
    radius: 9, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1,
  }).addTo(map);
  if (state.circle) state.circle.remove();
  state.circle = L.circle([loc.lat, loc.lon], {
    radius: state.nearMetres, color, weight: 1, dashArray: '3 3', fill: false, interactive: false,
  }).addTo(map);
  state.marker.bindTooltip(esc(loc.label));
  if (state.plotLayer) {
    map.fitBounds(state.plotLayer.getBounds().pad(0.6), { maxZoom: 19 });
  } else {
    map.setView([loc.lat, loc.lon], Math.max(map.getZoom(), 17));
  }
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
    offlineA4: state.offlineA4, legacyA4: state.legacyA4, boundary: state.boundary, nearMetres: state.nearMetres,
    coverageCache: state.coverageCache,
  };
}

function verdict(r) {
  const a4 = r.article4;
  if (a4.status === 'inside') {
    return { cls: a4.borderline ? 'v-border' : 'v-in', title: a4.borderline ? 'Inside an Article 4 area — near the boundary' : 'Inside an Article 4 direction area' };
  }
  if (a4.status === 'plot') {
    return { cls: 'v-border', title: 'Part of the plot is in an Article 4 area' };
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
    'offline-snapshot': 'Checked against the saved copy of the official boundaries (offline)',
    'offline-legacy': 'Checked against the 2022 copy held in this repository (offline)',
  }[a4.method] || '';

  const dirHtml = a4.directions.length ? `
    <ul class="dir-list">${a4.directions.map((d) => `
      <li>${d.reference ? `<strong>${esc(d.reference)}</strong> ` : ''}${esc(d.name)}
        ${d.startDate ? `<span class="muted">· in force from ${esc(d.startDate)}</span>` : ''}
        ${d.entity ? `· <a href="${entityUrl(d.entity)}" target="_blank" rel="noopener">record</a>` : ''}
        ${d.documentUrl ? `· <a href="${esc(d.documentUrl)}" target="_blank" rel="noopener">direction document</a>` : ''}
        ${d.description ? `<div class="muted small">${esc(d.description)}</div>` : ''}
      </li>`).join('')}</ul>` : '';
  const rightsHtml = (a4.restrictions || []).length ? `
    <div class="rights"><span class="rights-label">Rights removed</span>
      ${a4.restrictions.map((t) => `<p>${esc(t)}</p>`).join('')}</div>` : '';

  const areaHtml = a4.areas.length ? `<p class="small">Area${a4.areas.length > 1 ? 's' : ''}: ${a4.areas.map((a) =>
    `${a.entity ? `<a href="${entityUrl(a.entity)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)}${a.onPlot ? ' <span class="where where-plot">part of plot</span>' : ''}${a.distanceToEdge != null ? ` <span class="muted">(${Math.round(a.distanceToEdge)} m from edge)</span>` : ''}`).join(', ')}</p>` : '';
  const nearA4 = a4.status === 'outside' && a4.near.length ? `<p class="small">Nearby: ${a4.near.map((a) =>
    `${esc(a.name)}${a.distance != null ? ` (${Math.round(a.distance)} m)` : ''}`).join(', ')}</p>` : '';

  const checklistHtml = renderChecklist(r);
  const recordsHtml = renderAllRecords(r);

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
      <dt>Borough</dt><dd>${r.insideKingston === true ? 'Kingston upon Thames' : r.insideKingston === false ? '<strong>Outside Kingston</strong>' : '–'}${r.ward ? ` <span class="muted">· ${esc(r.ward)} ward</span>` : ''}</dd>
      ${r.plot ? `<dt>Plot</dt><dd>Land Registry INSPIRE ID <a href="${entityUrl(r.plot.entity)}" target="_blank" rel="noopener">${esc(r.plot.inspireId)}</a> <span class="muted">· about ${esc(r.plot.areaM2.toLocaleString('en-GB'))} m²${r.plot.otherTitles ? ` · ${r.plot.otherTitles} other title${r.plot.otherTitles > 1 ? 's' : ''} here` : ''}</span></dd>` : ''}
    </dl>
    ${alts}
    ${warnHtml}
    ${a4.status === 'inside' || a4.status === 'plot' || a4.near.length ? `<section><h3>Article 4</h3>${dirHtml}${rightsHtml}${areaHtml}${nearA4}</section>` : ''}
    ${checklistHtml}
    ${recordsHtml}
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

function renderChecklist(r) {
  const rows = r.checklist || [];
  if (!rows.length) return '';
  const sections = [];
  for (const c of rows) {
    let sec = sections.find((x) => x.name === c.section);
    if (!sec) sections.push(sec = { name: c.section, rows: [] });
    sec.rows.push(c);
  }
  const found = rows.filter((c) => ['yes', 'plot', 'near'].includes(c.status)).length;
  const notPub = rows.filter((c) => c.status === 'not_published').length;
  const itemHtml = (c) => {
    if (!c.items.length) return '';
    const seen = new Set();
    return `<ul class="ck-items">${c.items.filter((i) => {
      const k = `${i.entity}|${i.where}`; if (seen.has(k)) return false; seen.add(k); return true;
    }).map((i) => {
      const extra = [i.grade && `Grade ${i.grade}`, i.level && `Level ${i.level}`].filter(Boolean).join(' · ');
      const where = i.where === 'plot' ? '<span class="where where-plot">on plot</span>' : i.where === 'near' ? `<span class="where where-near">within ${state.nearMetres} m</span>` : '';
      const name = i.name || 'Unnamed record';
      return `<li>${i.entity ? `<a href="${entityUrl(i.entity)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name)}${extra ? ` <span class="muted">${esc(extra)}</span>` : ''} ${where}</li>`;
    }).join('')}</ul>`;
  };
  return `
    <section class="checklist">
      <h3>Search checklist</h3>
      <p class="muted small">${found} found${notPub ? ` · ${notPub} not published for this area, so they can't be answered here` : ''}</p>
      ${sections.map((sec) => `
        <h4>${esc(sec.name)}</h4>
        <ul class="ck">${sec.rows.map((c) => `
          <li class="ck-row ck-${c.status}">
            <span class="ck-label">${esc(c.label)}</span>
            <span class="chip chip-${c.status}">${esc(STATUS_TEXT[c.status] || c.status)}</span>
            ${itemHtml(c)}
          </li>`).join('')}</ul>`).join('')}
    </section>`;
}

function renderAllRecords(r) {
  if (!r.dataSource) return '';
  const all = [
    ...r.designations.map((d) => ({ ...d, where: 'point' })),
    ...(r.plotDesignations || []).map((d) => ({ ...d, where: 'plot' })),
    ...r.nearby.filter((d) => d.dataset !== 'title-boundary').map((d) => ({ ...d, where: 'near' })),
  ];
  if (!all.length) return '';
  const label = { point: 'At the point', plot: 'Elsewhere on the plot', near: `Within ${state.nearMetres} m` };
  const blocks = ['point', 'plot', 'near'].map((w) => {
    const list = all.filter((d) => d.where === w);
    return list.length ? `<h4>${label[w]} (${list.length})</h4><ul>${list.map(designationItem).join('')}</ul>` : '';
  }).join('');
  return `<details class="records"><summary>All records found (${all.length})</summary>${blocks}</details>`;
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
  const a4Text = { Y: 'YES', N: 'No', 'PART OF PLOT': 'PART OF PLOT' }[row.article4] || 'Unknown';
  const lines = [
    `Location: ${row.matched_location}`,
    `Grid ref: E ${row.easting} N ${row.northing} (${precisionLabel(r.location.precision)})`,
  ];
  if (row.land_registry_inspire_id) lines.push(`Land Registry plot: INSPIRE ID ${row.land_registry_inspire_id} (about ${row.plot_area_m2} m2)`);
  if (row.ward) lines.push(`Ward: ${row.ward}`);
  lines.push(`Article 4: ${a4Text}${row.article4_borderline === 'Y' ? ' (borderline - verify)' : ''}`);
  if (row.article4_directions) lines.push(`  Direction(s): ${row.article4_directions}`);
  if (row.article4_rights_removed) lines.push(`  Rights removed: ${row.article4_rights_removed}`);
  if (row.article4_areas) lines.push(`  Area(s): ${row.article4_areas}`);
  let section = '';
  for (const c of r.checklist || []) {
    if (c.id === 'article4') continue;
    if (c.section !== section) { section = c.section; lines.push('', section.toUpperCase()); }
    lines.push(`  ${c.label}: ${row[c.id] || ''}`);
  }
  if (row.warnings) lines.push('', `Notes: ${row.warnings}`);
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
