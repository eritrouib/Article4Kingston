(function () {
'use strict';

// Core lookup logic (plain script, no modules, so the page also works when opened
// straight from disk). Exposes everything on globalThis.A4Lookup.
// Core lookup logic: input parsing, geocoding, planning-constraint queries and
// geometry helpers. No DOM access here so it can be tested in Node.

const PLANNING_API = 'https://www.planning.data.gov.uk';
const POSTCODES_API = 'https://api.postcodes.io';
const NOMINATIM_API = 'https://nominatim.openstreetmap.org';
const KINGSTON_ORG_ENTITY = 188; // Royal Borough of Kingston upon Thames on planning.data.gov.uk

// Kingston bounding box (lon/lat) used to bias/limit address searches.
const KINGSTON_BBOX = [-0.3308, 51.3263, -0.2387, 51.4373];

const BNG_PROJ4 =
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 ' +
  '+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs';

// ---------------------------------------------------------------------------
// Dataset metadata: how each planning.data.gov.uk dataset is labelled and grouped.
// Anything not listed still appears, under "Other".
// ---------------------------------------------------------------------------
const GROUPS = {
  a4: 'Article 4',
  heritage: 'Heritage',
  trees: 'Trees',
  nature: 'Nature & environment',
  flood: 'Flood risk',
  land: 'Green belt, open land & landscape',
  policy: 'Plans, policy & sites',
  other: 'Other',
  admin: 'Administrative areas',
};

const DATASETS = {
  'article-4-direction-area': { label: 'Article 4 direction area', group: 'a4' },
  'conservation-area': { label: 'Conservation area', group: 'heritage' },
  'listed-building': { label: 'Listed building', group: 'heritage' },
  'listed-building-outline': { label: 'Listed building (outline)', group: 'heritage' },
  'locally-listed-building': { label: 'Locally listed building', group: 'heritage' },
  'building-preservation-notice': { label: 'Building preservation notice', group: 'heritage' },
  'certificate-of-immunity': { label: 'Certificate of immunity from listing', group: 'heritage' },
  'scheduled-monument': { label: 'Scheduled monument', group: 'heritage' },
  'park-and-garden': { label: 'Registered park and garden', group: 'heritage' },
  'archaeological-priority-area': { label: 'Archaeological priority area', group: 'heritage' },
  'heritage-at-risk': { label: 'Heritage at risk', group: 'heritage' },
  'world-heritage-site': { label: 'World heritage site', group: 'heritage' },
  'world-heritage-site-buffer-zone': { label: 'World heritage site buffer zone', group: 'heritage' },
  'battlefield': { label: 'Registered battlefield', group: 'heritage' },
  'tree-preservation-zone': { label: 'Tree preservation order area', group: 'trees' },
  'tree': { label: 'Protected tree (TPO)', group: 'trees' },
  'ancient-woodland': { label: 'Ancient woodland', group: 'trees' },
  'site-of-special-scientific-interest': { label: 'Site of special scientific interest (SSSI)', group: 'nature' },
  'local-nature-reserve': { label: 'Local nature reserve', group: 'nature' },
  'national-nature-reserve': { label: 'National nature reserve', group: 'nature' },
  'special-area-of-conservation': { label: 'Special area of conservation', group: 'nature' },
  'special-protection-area': { label: 'Special protection area', group: 'nature' },
  'ramsar-site': { label: 'Ramsar site', group: 'nature' },
  'air-quality-management-area': { label: 'Air quality management area', group: 'nature' },
  'smoke-control-area': { label: 'Smoke control area', group: 'nature' },
  'contaminated-land': { label: 'Contaminated land', group: 'nature' },
  'flood-risk-zone': { label: 'Flood risk zone', group: 'flood' },
  'flood-storage-area': { label: 'Flood storage area', group: 'flood' },
  'green-belt': { label: 'Green belt', group: 'land' },
  'common-land-and-village-green': { label: 'Common land / village green', group: 'land' },
  'area-of-outstanding-natural-beauty': { label: 'National landscape (AONB)', group: 'land' },
  'local-green-space': { label: 'Local green space', group: 'land' },
  'agricultural-land-classification': { label: 'Agricultural land classification', group: 'land' },
  'asset-of-community-value': { label: 'Asset of community value', group: 'policy' },
  'brownfield-land': { label: 'Brownfield land register', group: 'policy' },
  'brownfield-site': { label: 'Brownfield site', group: 'policy' },
  'local-development-order': { label: 'Local development order', group: 'policy' },
  'neighbourhood-plan-area': { label: 'Neighbourhood plan area', group: 'policy' },
  'development-policy-area': { label: 'Development policy area', group: 'policy' },
  'central-activities-zone': { label: 'Central activities zone', group: 'policy' },
  'control-of-major-accident-hazards-site': { label: 'Major accident hazard site (COMAH)', group: 'policy' },
  'local-authority-district': { label: 'Local authority district', group: 'admin' },
  'local-planning-authority': { label: 'Local planning authority', group: 'admin' },
  'local-authority': { label: 'Local authority', group: 'admin' },
  'local-authority-eng': { label: 'Local authority', group: 'admin' },
  'parish': { label: 'Parish', group: 'admin' },
  'ward': { label: 'Ward', group: 'admin' },
  'border': { label: 'Border', group: 'admin' },
  'built-up-area': { label: 'Built-up area', group: 'admin' },
  'region': { label: 'Region', group: 'admin' },
  'address': { label: 'Address', group: 'admin' },
  'title-boundary': { label: 'Land Registry title boundary', group: 'admin' },
  'local-plan-boundary': { label: 'Local plan boundary', group: 'admin' },
  'waste-plan-boundary': { label: 'Waste plan boundary', group: 'admin' },
  'local-resilience-forum-boundary': { label: 'Local resilience forum', group: 'admin' },
  'road': { label: 'Road', group: 'admin' },
};

function datasetInfo(dataset) {
  return DATASETS[dataset] || { label: humanise(dataset), group: 'other' };
}

function humanise(s) {
  const t = String(s || '').replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------
const POSTCODE_RE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i;
const POSTCODE_IN_TEXT_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

function normalisePostcode(pc) {
  const m = String(pc || '').trim().match(POSTCODE_RE);
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null;
}

function extractPostcode(text) {
  const m = String(text || '').match(POSTCODE_IN_TEXT_RE);
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : null;
}

/**
 * Work out what kind of location the user typed.
 * Returns {type: 'postcode'|'bng'|'latlon'|'address', ...}
 */
function parseQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return { type: 'empty' };

  const pc = normalisePostcode(q);
  if (pc) return { type: 'postcode', postcode: pc, text: q };

  const nums = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (nums) {
    const a = parseFloat(nums[1]);
    const b = parseFloat(nums[2]);
    // British National Grid easting/northing (metres)
    if (a >= 0 && a <= 700000 && b >= 0 && b <= 1300000 && (a > 1000 || b > 1000)) {
      return { type: 'bng', easting: a, northing: b, text: q };
    }
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
      // Accept "lat, lon"; if it looks reversed for the UK, swap.
      if (Math.abs(a) < 10 && b > 40 && b < 70) return { type: 'latlon', lat: b, lon: a, text: q };
      return { type: 'latlon', lat: a, lon: b, text: q };
    }
  }
  return { type: 'address', text: q, postcode: extractPostcode(q) };
}

// ---------------------------------------------------------------------------
// Coordinate conversion
// ---------------------------------------------------------------------------
function bngToLatLon(proj4, easting, northing) {
  const [lon, lat] = proj4(BNG_PROJ4, 'WGS84', [easting, northing]);
  return { lat, lon };
}

function latLonToBng(proj4, lat, lon) {
  const [e, n] = proj4('WGS84', BNG_PROJ4, [lon, lat]);
  return { easting: Math.round(e), northing: Math.round(n) };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function getJson(fetchFn, url, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return { __notFound: true };
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true, status: res.status });
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.fatal || attempt === retries) break;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------

/**
 * Resolve a parsed query to a location.
 * Returns {lat, lon, label, source, precision, postcode?}
 *   precision: 'exact' (coordinates given), 'address' (matched address point),
 *              'street' (street-level match), 'postcode' (postcode centroid)
 */
async function geocode(parsed, { fetch: fetchFn, proj4, throttle } = {}) {
  switch (parsed.type) {
    case 'latlon':
      return {
        lat: parsed.lat, lon: parsed.lon, label: `${parsed.lat.toFixed(6)}, ${parsed.lon.toFixed(6)}`,
        source: 'Coordinates entered', precision: 'exact',
      };
    case 'bng': {
      const { lat, lon } = bngToLatLon(proj4, parsed.easting, parsed.northing);
      return {
        lat, lon, label: `E ${parsed.easting}, N ${parsed.northing}`,
        source: 'Grid reference entered', precision: 'exact',
        easting: parsed.easting, northing: parsed.northing,
      };
    }
    case 'postcode':
      return geocodePostcode(fetchFn, parsed.postcode);
    case 'address': {
      if (throttle) await throttle();
      const hit = await geocodeAddress(fetchFn, parsed.text);
      if (hit) return hit;
      if (parsed.postcode) {
        const pc = await geocodePostcode(fetchFn, parsed.postcode);
        pc.warnings = ['Address not matched; used the postcode centre instead.'];
        return pc;
      }
      throw new Error('Address not found. Try adding the postcode, or enter a postcode or grid reference.');
    }
    default:
      throw new Error('Enter an address, postcode, grid reference (easting, northing) or lat, lon.');
  }
}

async function geocodePostcode(fetchFn, postcode) {
  const enc = encodeURIComponent(postcode);
  let data = await getJson(fetchFn, `${POSTCODES_API}/postcodes/${enc}`);
  let terminated = false;
  if (data.__notFound) {
    data = await getJson(fetchFn, `${POSTCODES_API}/terminated_postcodes/${enc}`);
    if (data.__notFound) throw new Error(`Postcode ${postcode} not found.`);
    terminated = true;
  }
  const r = data.result;
  if (r.latitude == null) throw new Error(`Postcode ${postcode} has no location on record.`);
  return {
    lat: r.latitude, lon: r.longitude,
    label: postcode + (r.admin_district ? `, ${r.admin_district}` : ''),
    source: terminated ? 'Postcode centre (terminated postcode)' : 'Postcode centre (postcodes.io)',
    precision: 'postcode', postcode,
    adminDistrict: r.admin_district || null,
    easting: r.eastings ?? null, northing: r.northings ?? null,
    warnings: terminated ? [`${postcode} is a terminated postcode.`] : [],
  };
}

async function geocodeAddress(fetchFn, text) {
  const [w, s, e, n] = KINGSTON_BBOX;
  const pad = 0.02;
  const params = new URLSearchParams({
    q: text, format: 'jsonv2', addressdetails: '1', limit: '5', countrycodes: 'gb',
    viewbox: `${w - pad},${n + pad},${e + pad},${s - pad}`, bounded: '1',
  });
  const data = await getJson(fetchFn, `${NOMINATIM_API}/search?${params}`);
  if (!Array.isArray(data) || !data.length) return null;
  const best = data[0];
  const exact = best.address && (best.address.house_number || best.address.house_name ||
    ['house', 'building', 'residential', 'apartments', 'detached', 'semidetached_house', 'terrace']
      .includes(best.type));
  return {
    lat: parseFloat(best.lat), lon: parseFloat(best.lon),
    label: best.display_name,
    source: 'Address match (OpenStreetMap)',
    precision: exact ? 'address' : 'street',
    postcode: best.address && best.address.postcode ? normalisePostcode(best.address.postcode) : null,
    warnings: exact ? [] : ['Matched to a street or area, not a specific building. Check the location on the map.'],
    alternatives: data.slice(1).map((d) => ({ lat: +d.lat, lon: +d.lon, label: d.display_name })),
  };
}

// ---------------------------------------------------------------------------
// Planning data queries
// ---------------------------------------------------------------------------
function isCurrent(entity, today) {
  const end = entity['end-date'];
  return !end || end > today;
}

/** Square polygon (WKT) of half-width `metres` around a point. */
function bufferWkt(lat, lon, metres) {
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.cos((lat * Math.PI) / 180));
  const f = (x) => x.toFixed(7);
  const w = f(lon - dLon), e = f(lon + dLon), s = f(lat - dLat), n = f(lat + dLat);
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

async function fetchAllEntities(fetchFn, params) {
  const out = [];
  let url = `${PLANNING_API}/entity.json?${params}`;
  for (let page = 0; page < 10 && url; page++) {
    const data = await getJson(fetchFn, url);
    if (data.__notFound) break;
    out.push(...(data.entities || []));
    const next = data.links && data.links.next;
    url = next && (data.entities || []).length ? absolute(next) : null;
  }
  return out;
}

function absolute(u) {
  return u.startsWith('http') ? u : PLANNING_API + u;
}

// ---------------------------------------------------------------------------
// LLC search checklist: the questions a Local Land Charges search usually asks,
// and which Planning Data datasets answer each one.
// ---------------------------------------------------------------------------
const CHECKLIST = [
  { id: 'article4', section: 'Planning restrictions', label: 'Article 4 direction', datasets: ['article-4-direction-area'] },
  { id: 'ldo', section: 'Planning restrictions', label: 'Local development order', datasets: ['local-development-order'] },
  { id: 'conservation', section: 'Heritage', label: 'Conservation area', datasets: ['conservation-area'] },
  { id: 'listed', section: 'Heritage', label: 'Listed building', datasets: ['listed-building', 'listed-building-outline'] },
  { id: 'locally_listed', section: 'Heritage', label: 'Locally listed building', datasets: ['locally-listed-building'] },
  { id: 'bpn', section: 'Heritage', label: 'Building preservation notice', datasets: ['building-preservation-notice'] },
  { id: 'immunity', section: 'Heritage', label: 'Certificate of immunity from listing', datasets: ['certificate-of-immunity'] },
  { id: 'monument', section: 'Heritage', label: 'Scheduled monument', datasets: ['scheduled-monument'] },
  { id: 'park_garden', section: 'Heritage', label: 'Registered park or garden', datasets: ['park-and-garden'] },
  { id: 'archaeology', section: 'Heritage', label: 'Archaeological priority area', datasets: ['archaeological-priority-area'] },
  { id: 'heritage_risk', section: 'Heritage', label: 'Heritage at risk', datasets: ['heritage-at-risk'] },
  { id: 'tpo', section: 'Trees', label: 'Tree preservation order', datasets: ['tree-preservation-zone', 'tree'] },
  { id: 'ancient_woodland', section: 'Trees', label: 'Ancient woodland', datasets: ['ancient-woodland'] },
  { id: 'flood', section: 'Environment', label: 'Flood risk zone', datasets: ['flood-risk-zone'] },
  { id: 'aqma', section: 'Environment', label: 'Air quality management area', datasets: ['air-quality-management-area'] },
  { id: 'smoke', section: 'Environment', label: 'Smoke control area', datasets: ['smoke-control-area'] },
  { id: 'contaminated', section: 'Environment', label: 'Contaminated land', datasets: ['contaminated-land'] },
  { id: 'green_belt', section: 'Land & nature', label: 'Green belt', datasets: ['green-belt'] },
  { id: 'common_land', section: 'Land & nature', label: 'Common land / village green', datasets: ['common-land-and-village-green'] },
  { id: 'local_green_space', section: 'Land & nature', label: 'Local green space', datasets: ['local-green-space'] },
  { id: 'sssi', section: 'Land & nature', label: 'Site of special scientific interest', datasets: ['site-of-special-scientific-interest'] },
  { id: 'nature_reserve', section: 'Land & nature', label: 'Local nature reserve', datasets: ['local-nature-reserve'] },
  { id: 'brownfield', section: 'Sites & community', label: 'Brownfield land register', datasets: ['brownfield-land', 'brownfield-site'] },
  { id: 'acv', section: 'Sites & community', label: 'Asset of community value', datasets: ['asset-of-community-value'] },
  { id: 'neighbourhood', section: 'Sites & community', label: 'Neighbourhood plan area', datasets: ['neighbourhood-plan-area'] },
];
const CHECKLIST_DATASETS = [...new Set(CHECKLIST.flatMap((c) => c.datasets))];

// ---------------------------------------------------------------------------
// Spatial queries with sanity checks.
// Planning Data occasionally ignores a location filter (seen with some URL
// encodings of WKT shapes) and returns unrelated records. A genuine spatial
// answer for a place in England always includes the England border or the
// local authority district, so anything else is rejected and retried.
// ---------------------------------------------------------------------------
async function entitySearch(fetchFn, params, maxPages = 10) {
  const list = [];
  let count = null;
  let url = `${PLANNING_API}/entity.json?${params}`;
  for (let page = 0; page < maxPages && url; page++) {
    const data = await getJson(fetchFn, url);
    if (data.__notFound) break;
    if (count == null && typeof data.count === 'number') count = data.count;
    list.push(...(data.entities || []));
    const next = data.links && data.links.next;
    url = next && (data.entities || []).length ? absolute(next) : null;
  }
  return { list, count };
}

function looksSpatial(list) {
  return list.some((e) => e.dataset === 'border' || e.dataset === 'local-authority-district');
}

function looksFiltered(res) {
  // An ignored filter returns the whole national register (millions of records)
  // or organisation records, which are never geographic answers.
  if (res.count != null && res.count > 5000) return false;
  return !res.list.some((e) => e.typology === 'organisation' || e.dataset === 'local-authority');
}

/** WKT for a query string. Only spaces are escaped by default; some services mishandle %2C/%28. */
function wktParam(wkt, style = 'raw') {
  return style === 'raw' ? wkt.replace(/ /g, '%20') : encodeURIComponent(wkt);
}

async function pointQuery(fetchFn, lat, lon) {
  const params = `limit=100&exclude_field=geometry&latitude=${lat.toFixed(7)}&longitude=${lon.toFixed(7)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { list } = await entitySearch(fetchFn, params);
    if (looksSpatial(list)) return list;
    if (!list.length) return list; // outside England / nothing recorded
  }
  throw new Error('Planning Data gave an unexpected answer for this point');
}

async function nearQuery(fetchFn, lat, lon, metres) {
  const wkt = bufferWkt(lat, lon, metres);
  for (const style of ['raw', 'encoded']) {
    const { list } = await entitySearch(fetchFn,
      `geometry_relation=intersects&geometry=${wktParam(wkt, style)}&limit=100&exclude_field=geometry`);
    if (looksSpatial(list)) return list;
  }
  return null; // couldn't get a trustworthy answer
}

/** Area of a (multi)polygon in square metres (planar, local projection). */
function geometryArea(geometry) {
  let lat0 = null, lon0 = null;
  for (const poly of polygonsOf(geometry)) { if (poly[0] && poly[0][0]) { [lon0, lat0] = poly[0][0]; break; } }
  if (lat0 == null) return 0;
  const proj = toLocal(lat0, lon0);
  let total = 0;
  for (const poly of polygonsOf(geometry)) {
    poly.forEach((ring, i) => {
      const pts = ring.map(proj);
      let a = 0;
      for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) a += (pts[j][0] + pts[k][0]) * (pts[j][1] - pts[k][1]);
      total += (i === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return total;
}

async function fetchEntityGeometry(fetchFn, entity) {
  const data = await getJson(fetchFn, `${PLANNING_API}/entity/${entity}.geojson`);
  if (data.__notFound) return null;
  if (data.type === 'Feature') return data.geometry || null;
  if (data.type === 'FeatureCollection') return (data.features && data.features[0] && data.features[0].geometry) || null;
  return data.geometry || null;
}

/**
 * Find the Land Registry plot (INSPIRE title boundary) at the point and list what
 * genuinely overlaps it. "Touching" along a shared edge is not counted, so a
 * conservation area whose boundary follows the plot edge doesn't show as on the plot.
 */
async function plotQuery(fetchFn, atList, lat, lon, today) {
  const titles = atList.filter((e) => e.dataset === 'title-boundary').slice(0, 4);
  if (!titles.length) return null;
  const withGeom = await Promise.all(titles.map(async (t) => {
    try {
      const geometry = await fetchEntityGeometry(fetchFn, t.entity);
      return geometry ? { entity: t.entity, reference: t.reference, geometry, areaM2: geometryArea(geometry) } : null;
    } catch { return null; }
  }));
  const candidates = withGeom.filter(Boolean);
  if (!candidates.length) return null;
  // Freehold and leasehold titles can overlap; the smallest one containing the point
  // is almost always the property itself rather than an estate or block.
  const containing = candidates.filter((c) => pointInGeometry(lat, lon, c.geometry));
  const plot = (containing.length ? containing : candidates).sort((a, b) => a.areaM2 - b.areaM2)[0];

  const base = `geometry_entity=${plot.entity}&limit=100&exclude_field=geometry`;
  const results = await Promise.all(['overlaps', 'within', 'contains'].map(async (rel) => {
    try {
      const res = await entitySearch(fetchFn, `geometry_relation=${rel}&${base}`);
      return looksFiltered(res) ? res.list : null;
    } catch { return null; }
  }));
  if (results.every((r) => r === null)) return { ...plot, entities: null };
  const entities = dedupe(results.flatMap((r) => r || []).filter((e) => isCurrent(e, today) && e.entity !== plot.entity));
  return { ...plot, entities, otherTitles: candidates.length - 1 };
}

/**
 * Which checklist datasets have any records in this local authority.
 * true = published here, false = none published (or dataset doesn't exist), null = couldn't check.
 */
async function fetchCoverage(fetchFn, ladEntity, datasets = CHECKLIST_DATASETS, concurrency = 6) {
  const out = {};
  const queue = [...datasets];
  async function worker() {
    while (queue.length) {
      const ds = queue.shift();
      try {
        const data = await getJson(fetchFn, `${PLANNING_API}/entity.json?dataset=${ds}` +
          `&geometry_entity=${ladEntity}&geometry_relation=intersects&limit=1&field=entity&field=dataset`, { retries: 1 });
        const ents = data.entities || [];
        if (data.__notFound) out[ds] = false;
        else if (typeof data.count === 'number' && data.count > 1e6) out[ds] = null; // filter ignored
        else if (ents.some((e) => e.dataset && e.dataset !== ds)) out[ds] = null;
        else out[ds] = (data.count || ents.length) > 0;
      } catch (e) {
        out[ds] = e.status === 422 || e.status === 400 ? false : null;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

/**
 * Query planning.data.gov.uk for everything at a point, on the Land Registry plot
 * containing it, and within `nearMetres`. Returns current entities only:
 * {at, plot, near, nearChecked, ladEntity}
 */
async function queryPlanningData(fetchFn, lat, lon, { nearMetres = 25, today, plot: wantPlot = true } = {}) {
  today = today || new Date().toISOString().slice(0, 10);
  const [at, nearAll] = await Promise.all([
    pointQuery(fetchFn, lat, lon),
    nearMetres > 0 ? nearQuery(fetchFn, lat, lon, nearMetres).catch(() => null) : Promise.resolve([]),
  ]);
  const atCurrent = dedupe(at.filter((e) => isCurrent(e, today)));
  const atIds = new Set(atCurrent.map((e) => e.entity));
  let plot = null;
  if (wantPlot) {
    try { plot = await plotQuery(fetchFn, atCurrent, lat, lon, today); } catch { plot = null; }
  }
  const plotIds = new Set(((plot && plot.entities) || []).map((e) => e.entity));
  const plotOnly = plot && plot.entities ? plot.entities.filter((e) => !atIds.has(e.entity)) : [];
  const near = nearAll === null ? [] : dedupe(nearAll.filter((e) =>
    isCurrent(e, today) && !atIds.has(e.entity) && !plotIds.has(e.entity) && (!plot || e.entity !== plot.entity)));
  const lad = atCurrent.find((e) => e.dataset === 'local-authority-district');
  return {
    at: atCurrent, plot, plotOnly, near, nearChecked: nearAll !== null,
    ladEntity: lad ? lad.entity : null, ladName: lad ? lad.name : null,
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => (seen.has(e.entity) ? false : (seen.add(e.entity), true)));
}

/** Fetch Kingston's Article 4 directions (the legal instruments) keyed by reference. */
async function fetchArticle4Directions(fetchFn, orgEntity = KINGSTON_ORG_ENTITY) {
  const list = await fetchAllEntities(fetchFn,
    `dataset=article-4-direction&organisation_entity=${orgEntity}&limit=100`);
  const byRef = {};
  for (const d of list) byRef[d.reference] = d;
  return byRef;
}

/** Fetch Kingston's Article 4 areas as GeoJSON (for the map and offline cross-checks). */
async function fetchArticle4Areas(fetchFn, orgEntity = KINGSTON_ORG_ENTITY) {
  const features = [];
  let url = `${PLANNING_API}/entity.geojson?dataset=article-4-direction-area&organisation_entity=${orgEntity}&limit=500`;
  for (let page = 0; page < 10 && url; page++) {
    const data = await getJson(fetchFn, url);
    if (data.__notFound) break;
    const feats = data.features || [];
    features.push(...feats);
    const next = data.links && data.links.next;
    url = next && feats.length ? absolute(next) : null;
  }
  const today = new Date().toISOString().slice(0, 10);
  return {
    type: 'FeatureCollection',
    features: features.filter((f) => f.geometry && isCurrent(f.properties || {}, today)),
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers (planar in a local metric projection — fine at street scale)
// ---------------------------------------------------------------------------
function toLocal(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  return ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky];
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(polygonsOf);
  return [];
}

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lat, lon, geometry) {
  return polygonsOf(geometry).some((poly) =>
    ringContains(poly[0], lon, lat) && !poly.slice(1).some((hole) => ringContains(hole, lon, lat)));
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Distance in metres from a point to the nearest edge of a (multi)polygon. */
function distanceToBoundary(lat, lon, geometry) {
  const proj = toLocal(lat, lon);
  let best = Infinity;
  for (const poly of polygonsOf(geometry)) {
    for (const ring of poly) {
      const pts = ring.map(proj);
      for (let i = 1; i < pts.length; i++) {
        const d = segDist(0, 0, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/**
 * Check a point against a FeatureCollection locally.
 * Returns {inside: Feature[], near: [{feature, distance}]} — near = outside but within `metres`.
 */
function checkAgainstFeatures(lat, lon, fc, metres = 25) {
  const inside = [];
  const near = [];
  for (const f of (fc && fc.features) || []) {
    const isIn = pointInGeometry(lat, lon, f.geometry);
    const d = distanceToBoundary(lat, lon, f.geometry);
    if (isIn) inside.push({ feature: f, distance: d });
    else if (d <= metres) near.push({ feature: f, distance: d });
  }
  return { inside, near };
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

/**
 * Run a full check for a location.
 * deps: {fetch, a4Areas (FeatureCollection|null, downloaded live at page load),
 *        a4Directions ({ref: entity}), offlineA4 (official snapshot saved in the repo,
 *        with .metadata.downloaded), legacyA4 (hand-digitised 2022 polygons, last resort),
 *        boundary (FeatureCollection), nearMetres}
 */
async function checkLocation(loc, deps) {
  const nearMetres = deps.nearMetres ?? 25;
  const warnings = [...(loc.warnings || [])];
  const result = {
    location: loc,
    checkedAt: new Date().toISOString(),
    insideKingston: null,
    article4: { status: 'unknown', areas: [], directions: [], near: [], method: null },
    designations: [],
    nearby: [],
    warnings,
    dataSource: null,
  };

  if (deps.boundary) {
    const kin = checkAgainstFeatures(loc.lat, loc.lon, deps.boundary, nearMetres);
    result.insideKingston = kin.inside.length > 0;
    if (!result.insideKingston) {
      warnings.push(kin.near.length
        ? 'This location is just outside the Kingston borough boundary. Check which authority it falls in.'
        : 'This location is outside the Royal Borough of Kingston upon Thames.');
    } else if (kin.inside[0].distance <= nearMetres) {
      warnings.push(`Within ${Math.round(kin.inside[0].distance)} m of the borough boundary.`);
    }
  }

  // 1. Authoritative live check
  let live = null;
  try {
    live = await queryPlanningData(deps.fetch, loc.lat, loc.lon, { nearMetres });
  } catch (e) {
    warnings.push(`Live planning data could not be reached (${e.message}). Article 4 result uses the offline copy; other designations are not checked.`);
  }

  const toArea = (e, onPlot) => ({
    entity: e.entity, reference: e.reference, name: e.name,
    direction: e['article-4-direction'] || null,
    startDate: e['start-date'] || null,
    notes: e.notes || '',
    pdRights: e['permitted-development-rights'] || '',
    organisation: e['organisation-entity'],
    onPlot: !!onPlot,
  });

  if (live) {
    result.dataSource = 'planning.data.gov.uk (live)';
    const isA4 = (e) => e.dataset === 'article-4-direction-area';
    const a4Point = live.at.filter(isA4);
    const a4Plot = live.plotOnly.filter(isA4);
    result.article4.method = 'live';
    result.article4.status = a4Point.length ? 'inside' : a4Plot.length ? 'plot' : 'outside';
    result.article4.areas = [...a4Point.map((e) => toArea(e, false)), ...a4Plot.map((e) => toArea(e, true))];
    result.designations = live.at.filter((e) => !isA4(e)).map(simplify);
    result.plotDesignations = live.plotOnly.filter((e) => !isA4(e)).map(simplify);
    result.nearby = live.near.map(simplify);
    result.article4.near = live.near
      .filter(isA4)
      .map((e) => ({ entity: e.entity, name: e.name, reference: e.reference, direction: e['article-4-direction'] || null }));
    if (live.plot) {
      result.plot = {
        entity: live.plot.entity, inspireId: live.plot.reference, geometry: live.plot.geometry,
        areaM2: Math.round(live.plot.areaM2), checked: live.plot.entities !== null, otherTitles: live.plot.otherTitles || 0,
      };
      if (live.plot.entities === null) warnings.push('The Land Registry plot was found, but designations on it could not be checked. Results are for the point only.');
    }
    if (!live.nearChecked) warnings.push(`Things within ${nearMetres} m could not be checked this time (Planning Data gave an unreliable answer). Results are for the point and plot only.`);
    const ward = live.at.find((e) => e.dataset === 'ward');
    result.ward = ward ? ward.name : null;
    result.authority = live.ladName;
    if (live.ladEntity) {
      result.coverage = await getCoverageCached(deps, live.ladEntity);
    }
  }

  // 2. Local geometry cross-check (distance to boundary, and fallback when offline)
  const hasFeatures = (fc) => !!(fc && fc.features && fc.features.length);
  const localFc = hasFeatures(deps.a4Areas) ? deps.a4Areas
    : hasFeatures(deps.offlineA4) ? deps.offlineA4
      : deps.legacyA4;
  const usingLegacy = localFc === deps.legacyA4;
  const usingSnapshot = localFc === deps.offlineA4;
  if (localFc) {
    const local = checkAgainstFeatures(loc.lat, loc.lon, localFc, nearMetres);
    if (!live) {
      result.article4.method = usingLegacy ? 'offline-legacy' : usingSnapshot ? 'offline-snapshot' : 'offline';
      result.article4.status = local.inside.length ? 'inside' : 'outside';
      result.article4.areas = local.inside.map(({ feature }) => featureToArea(feature));
      result.article4.near = local.near.map(({ feature, distance }) => ({ ...featureToArea(feature), distance }));
      if (usingLegacy) {
        warnings.push('Offline copy is the 2022 data recovered from this repository. It does not include the Seething Wells (2021) or North/South Lodge (2023) directions.');
      } else if (usingSnapshot) {
        const saved = deps.offlineA4.metadata && deps.offlineA4.metadata.downloaded;
        warnings.push(`Used the official Article 4 boundaries saved in this tool${saved ? ` on ${saved.slice(0, 10)}` : ''}. Directions made or changed since then won't show.`);
      }
    } else if (!usingLegacy) {
      // Add distances to live near-boundary list; flag edge proximity when inside.
      const dist = new Map(local.near.map(({ feature, distance }) => [String(feature.properties.entity), distance]));
      for (const n of result.article4.near) n.distance = dist.get(String(n.entity)) ?? null;
      for (const a of result.article4.areas) {
        const hit = local.inside.find(({ feature }) => String(feature.properties.entity) === String(a.entity));
        if (hit) a.distanceToEdge = hit.distance;
      }
      const liveIn = result.article4.status === 'inside';
      const localIn = local.inside.length > 0;
      if (liveIn !== localIn) {
        warnings.push('Live point check and the downloaded Article 4 boundaries disagree for this location. Treat as borderline and check the direction map.');
      }
    }
  }

  // Borderline flags
  const edge = result.article4.areas.some((a) => a.distanceToEdge != null && a.distanceToEdge <= nearMetres);
  if (result.article4.status === 'plot') {
    result.article4.borderline = true;
    warnings.push('The point is outside, but part of the Land Registry plot is inside an Article 4 area. Check which part of the property is affected.');
  } else if (result.article4.status === 'outside' && result.article4.near.length) {
    result.article4.borderline = true;
    warnings.push(`An Article 4 boundary lies within ${nearMetres} m. Check the property footprint against the map.`);
  } else if (edge) {
    result.article4.borderline = true;
    warnings.push(`The Article 4 boundary is within ${nearMetres} m of this point. Check the property footprint against the map.`);
  }
  if (loc.precision === 'postcode') {
    warnings.push('Result is for the postcode centre, which may not be the property itself. Use the full address or a UPRN grid reference for a definitive answer.');
  }

  // Directions (legal instrument) details
  const dirs = deps.a4Directions || {};
  const byRef = new Map();
  for (const a of result.article4.areas) {
    const link = linkDirection(a, dirs);
    a.directionRef = link.ref;
    a.directionLinkedBy = link.how;
    const key = link.ref || `unlinked:${a.notes || a.name}`;
    if (!byRef.has(key)) {
      const d = link.ref ? dirs[link.ref] : null;
      byRef.set(key, d
        ? { reference: link.ref, name: d.name, startDate: d['start-date'] || null, description: d.description || d.notes || '',
            documentUrl: d['document-url'] || d['documentation-url'] || null, entity: d.entity, linkedBy: link.how }
        : { reference: null, name: a.notes || 'Article 4 direction (not identified in the published data)', linkedBy: null });
    }
  }
  result.article4.directions = [...byRef.values()];
  result.article4.restrictions = [...new Set(result.article4.areas.map((a) => a.pdRights).filter(Boolean))];

  result.checklist = buildChecklist(result, !!live);
  return result;
}

function displayName(d) {
  if (d.dataset === 'flood-risk-zone' && d.level) return `Flood zone ${d.level}`;
  return d.name || d.reference || '';
}

async function getCoverageCached(deps, ladEntity) {
  const cache = deps.coverageCache;
  if (cache && cache.has(ladEntity)) return cache.get(ladEntity);
  const p = fetchCoverage(deps.fetch, ladEntity).catch(() => null);
  if (cache) cache.set(ladEntity, p);
  const cov = await p;
  if (cache && !cov) cache.delete(ladEntity);
  return cov;
}

/**
 * One line per LLC question:
 *   yes       - applies at the point
 *   plot      - applies to part of the Land Registry plot, not the point
 *   near      - within the tolerance distance, but not on the point or plot
 *   no        - checked, nothing found, and this area does publish the data
 *   not_published - nothing found because this area publishes no such data
 *   unknown   - nothing found, couldn't confirm whether the data is published
 *   unchecked - not checked (live data unavailable)
 */
function buildChecklist(result, live) {
  const cov = result.coverage || {};
  const a4 = result.article4;
  return CHECKLIST.map((c) => {
    const items = [];
    if (c.id === 'article4') {
      for (const a of a4.areas) items.push({ name: a.name, where: a.onPlot ? 'plot' : 'point', entity: a.entity });
      for (const a of a4.near) items.push({ name: a.name, where: 'near', entity: a.entity });
    } else if (live) {
      const add = (list, where) => list.filter((d) => c.datasets.includes(d.dataset))
        .forEach((d) => items.push({ name: displayName(d), where, entity: d.entity, grade: d.grade,
          level: d.dataset === 'flood-risk-zone' ? null : d.level, dataset: d.dataset }));
      add(result.designations, 'point');
      add(result.plotDesignations || [], 'plot');
      add(result.nearby, 'near');
    }
    let status;
    if (items.some((i) => i.where === 'point')) status = 'yes';
    else if (items.some((i) => i.where === 'plot')) status = 'plot';
    else if (items.some((i) => i.where === 'near')) status = 'near';
    else if (c.id === 'article4' && a4.status === 'outside') status = 'no';
    else if (!live) status = 'unchecked';
    else {
      const flags = c.datasets.map((d) => cov[d]);
      status = flags.some((f) => f === true) ? 'no' : flags.every((f) => f === false) ? 'not_published' : 'unknown';
    }
    return { id: c.id, section: c.section, label: c.label, status, items };
  });
}

// Kingston's published areas don't reliably say which direction they belong to:
// their "article-4-direction" field repeats the area's own reference ("1".."114")
// instead of A4D1/A4D2/A4D3. Use that field when it matches a real direction,
// otherwise match the area's description against the direction names.
const LINK_STOP = new Set(['article', 'direction', 'directions', 'for', 'the', 'and', 'use', 'uses', 'area', 'areas',
  'a4d', 'removes', 'permitted', 'development', 'rights', 'right', 'change', 'with', 'from', 'this', 'that', 'site', 'sites']);
function linkWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w.length > 2 && !LINK_STOP.has(w)).map((w) => w.replace(/s$/, '')));
}

function linkDirection(area, directions) {
  const declared = area.direction != null ? String(area.direction) : '';
  if (declared && directions[declared]) return { ref: declared, how: 'published' };
  const areaWords = linkWords(`${area.notes || ''} ${area.name || ''}`);
  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const [ref, d] of Object.entries(directions || {})) {
    if (d['end-date'] && d['end-date'] <= new Date().toISOString().slice(0, 10)) continue;
    const dirWords = linkWords(d.name);
    let score = 0;
    for (const w of dirWords) if (areaWords.has(w)) score++;
    if (score > bestScore) { best = ref; bestScore = score; tie = false; } else if (score && score === bestScore) tie = true;
  }
  return best && bestScore >= 2 && !tie ? { ref: best, how: 'matched' } : { ref: null, how: null };
}

function featureToArea(f) {
  const p = f.properties || {};
  return {
    entity: p.entity ?? null, reference: p.reference ?? null, name: p.name ?? 'Article 4 area',
    direction: p['article-4-direction'] || null, startDate: p['start-date'] || null,
    notes: p.notes || '', pdRights: p['permitted-development-rights'] || '',
  };
}

function simplify(e) {
  const info = datasetInfo(e.dataset);
  return {
    dataset: e.dataset, label: info.label, group: info.group,
    entity: e.entity, reference: e.reference, name: e.name || e.reference || '',
    startDate: e['start-date'] || null,
    grade: e['listed-building-grade'] || null,
    level: e['flood-risk-level'] || null,
    documentUrl: e['document-url'] || e['documentation-url'] || null,
    organisation: e['organisation-entity'] ?? null,
  };
}

function entityUrl(entity) {
  return `${PLANNING_API}/entity/${entity}`;
}

// ---------------------------------------------------------------------------
// Batch / CSV helpers
// ---------------------------------------------------------------------------
const ALIASES = {
  query: ['query', 'search', 'location'],
  address: ['address', 'full_address', 'fulladdress', 'property', 'property_address', 'addr', 'site_address'],
  postcode: ['postcode', 'post_code', 'postal_code', 'pcode', 'pc'],
  easting: ['easting', 'x', 'x_coordinate', 'xcoord', 'east'],
  northing: ['northing', 'y', 'y_coordinate', 'ycoord', 'north'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'lng', 'long', 'longitude'],
};

function detectColumns(headers) {
  const norm = (h) => String(h).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const found = headers.find((h) => names.includes(norm(h)));
    if (found !== undefined) map[key] = found;
  }
  // Address split over several columns (address1, address2, town ...)
  const addrParts = headers.filter((h) => /^(address|addr|line|street|town|locality)_?\d*$/.test(norm(h)) && h !== map.address);
  if (!map.address && addrParts.length) map.addressParts = addrParts;
  return map;
}

/** Build a parsed query from one CSV row using detected columns. Prefers the most precise input. */
function rowToQuery(row, cols) {
  const v = (k) => (cols[k] !== undefined ? String(row[cols[k]] ?? '').trim() : '');
  const e = parseFloat(v('easting')), n = parseFloat(v('northing'));
  if (Number.isFinite(e) && Number.isFinite(n) && e > 1000 && n > 1000) {
    return { type: 'bng', easting: e, northing: n, text: `${e}, ${n}` };
  }
  const la = parseFloat(v('lat')), lo = parseFloat(v('lon'));
  if (Number.isFinite(la) && Number.isFinite(lo)) return { type: 'latlon', lat: la, lon: lo, text: `${la}, ${lo}` };
  let address = v('address');
  if (!address && cols.addressParts) address = cols.addressParts.map((c) => String(row[c] ?? '').trim()).filter(Boolean).join(', ');
  const postcode = v('postcode');
  if (address) {
    const full = postcode && !extractPostcode(address) ? `${address}, ${postcode}` : address;
    return { type: 'address', text: full, postcode: normalisePostcode(postcode) || extractPostcode(address) };
  }
  if (postcode) {
    const pc = normalisePostcode(postcode);
    if (pc) return { type: 'postcode', postcode: pc, text: postcode };
  }
  const q = v('query');
  if (q) return parseQuery(q);
  return { type: 'empty' };
}

const yn = (b) => (b === true ? 'Y' : b === false ? 'N' : '');

/** Flatten a check result into CSV output columns. */
const STATUS_CSV = {
  yes: 'Y', plot: 'PART OF PLOT', near: 'NEARBY', no: 'N',
  not_published: 'NOT PUBLISHED', unknown: 'NOT CONFIRMED', unchecked: 'NOT CHECKED',
};

function checklistCell(c) {
  const code = STATUS_CSV[c.status] || '';
  if (!c.items.length) return code;
  // Everything found is listed (the point first), so e.g. a Flood Zone 3 on part of
  // the plot isn't hidden behind a Zone 2 at the point.
  const order = { point: 0, plot: 1, near: 2 };
  const names = [...c.items].sort((a, b) => order[a.where] - order[b.where])
    .map((i) => {
      const extra = [i.grade && `Grade ${i.grade}`, i.level && `Level ${i.level}`].filter(Boolean).join(', ');
      const where = i.where === 'point' ? '' : i.where === 'plot' ? ' [plot]' : ' [nearby]';
      return `${i.name || 'unnamed'}${extra ? ` (${extra})` : ''}${where}`;
    });
  return `${code}: ${[...new Set(names)].join('; ')}`;
}

/** Flatten a check result into CSV output columns. */
function resultToRow(r) {
  const a4 = r.article4;
  const row = {
    matched_location: r.location ? r.location.label : '',
    location_precision: r.location ? r.location.precision : '',
    latitude: r.location ? r.location.lat.toFixed(6) : '',
    longitude: r.location ? r.location.lon.toFixed(6) : '',
    easting: r.location && r.location.easting != null ? r.location.easting : '',
    northing: r.location && r.location.northing != null ? r.location.northing : '',
    in_kingston: yn(r.insideKingston),
    ward: r.ward || '',
    land_registry_inspire_id: r.plot ? r.plot.inspireId : '',
    plot_area_m2: r.plot ? r.plot.areaM2 : '',
    article4: { inside: 'Y', plot: 'PART OF PLOT', outside: 'N' }[a4.status] || '',
    article4_borderline: yn(!!a4.borderline),
    article4_areas: a4.areas.map((a) => a.name + (a.onPlot ? ' [plot]' : '')).join('; '),
    article4_directions: a4.directions.map((d) => (d.reference ? `${d.reference} ${d.name}` : d.name)).join('; '),
    article4_rights_removed: (a4.restrictions || []).join('; '),
    article4_check_method: a4.method || '',
  };
  for (const c of r.checklist || []) {
    if (c.id === 'article4') continue;
    row[c.id] = checklistCell(c);
  }
  row.warnings = r.warnings.join(' | ');
  row.data_source = r.dataSource || (a4.method ? 'offline copy' : '');
  row.checked_at = r.checkedAt;
  return row;
}


globalThis.A4Lookup = {
  checklistCell,
  CHECKLIST,
  CHECKLIST_DATASETS,
  buildChecklist,
  fetchCoverage,
  geometryArea,
  wktParam,
  linkDirection,
  PLANNING_API,
  POSTCODES_API,
  NOMINATIM_API,
  KINGSTON_ORG_ENTITY,
  KINGSTON_BBOX,
  BNG_PROJ4,
  GROUPS,
  DATASETS,
  datasetInfo,
  normalisePostcode,
  extractPostcode,
  parseQuery,
  bngToLatLon,
  latLonToBng,
  sleep,
  geocode,
  geocodePostcode,
  geocodeAddress,
  bufferWkt,
  queryPlanningData,
  fetchArticle4Directions,
  fetchArticle4Areas,
  pointInGeometry,
  distanceToBoundary,
  checkAgainstFeatures,
  checkLocation,
  entityUrl,
  detectColumns,
  rowToQuery,
  resultToRow,
};
})();
