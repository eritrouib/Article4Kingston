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
  'listed-building-outline': { label: 'Listed building outline', group: 'heritage' },
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
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
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

/**
 * Query planning.data.gov.uk for everything at a point, and everything within
 * `nearMetres` of it. Returns {at: entity[], near: entity[]} (current entities only).
 */
async function queryPlanningData(fetchFn, lat, lon, { nearMetres = 25, today } = {}) {
  today = today || new Date().toISOString().slice(0, 10);
  const base = 'limit=100&exclude_field=geometry';
  const atParams = `${base}&latitude=${lat.toFixed(7)}&longitude=${lon.toFixed(7)}`;
  const nearParams = `${base}&geometry_relation=intersects&geometry=${encodeURIComponent(bufferWkt(lat, lon, nearMetres))}`;
  const [at, nearAll] = await Promise.all([
    fetchAllEntities(fetchFn, atParams),
    nearMetres > 0 ? fetchAllEntities(fetchFn, nearParams) : Promise.resolve([]),
  ]);
  const atCurrent = dedupe(at.filter((e) => isCurrent(e, today)));
  const atIds = new Set(atCurrent.map((e) => e.entity));
  const near = dedupe(nearAll.filter((e) => isCurrent(e, today) && !atIds.has(e.entity)));
  return { at: atCurrent, near };
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
 * deps: {fetch, a4Areas (FeatureCollection|null), a4Directions ({ref: entity}),
 *        legacyA4 (FeatureCollection), boundary (FeatureCollection), nearMetres}
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

  if (live) {
    result.dataSource = 'planning.data.gov.uk (live)';
    const a4 = live.at.filter((e) => e.dataset === 'article-4-direction-area');
    result.article4.method = 'live';
    result.article4.status = a4.length ? 'inside' : 'outside';
    result.article4.areas = a4.map((e) => ({
      entity: e.entity, reference: e.reference, name: e.name,
      direction: e['article-4-direction'] || null,
      startDate: e['start-date'] || null,
      notes: e.notes || e['permitted-development-rights'] || '',
      organisation: e['organisation-entity'],
    }));
    result.designations = live.at.filter((e) => e.dataset !== 'article-4-direction-area').map(simplify);
    result.nearby = live.near.map(simplify);
    result.article4.near = live.near
      .filter((e) => e.dataset === 'article-4-direction-area')
      .map((e) => ({ entity: e.entity, name: e.name, reference: e.reference, direction: e['article-4-direction'] || null }));
  }

  // 2. Local geometry cross-check (distance to boundary, and fallback when offline)
  const localFc = deps.a4Areas && deps.a4Areas.features && deps.a4Areas.features.length ? deps.a4Areas : deps.legacyA4;
  const usingLegacy = localFc === deps.legacyA4;
  if (localFc) {
    const local = checkAgainstFeatures(loc.lat, loc.lon, localFc, nearMetres);
    if (!live) {
      result.article4.method = usingLegacy ? 'offline-legacy' : 'offline';
      result.article4.status = local.inside.length ? 'inside' : 'outside';
      result.article4.areas = local.inside.map(({ feature }) => featureToArea(feature));
      result.article4.near = local.near.map(({ feature, distance }) => ({ ...featureToArea(feature), distance }));
      if (usingLegacy) {
        warnings.push('Offline copy is the 2022 data recovered from this repository. It does not include the Seething Wells (2021) or North/South Lodge (2023) directions.');
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
  if (result.article4.status === 'outside' && result.article4.near.length) {
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
  const refs = [...new Set(result.article4.areas.map((a) => a.direction).filter(Boolean))];
  result.article4.directions = refs.map((r) => {
    const d = dirs[r];
    return d
      ? { reference: r, name: d.name, startDate: d['start-date'] || null, description: d.description || d.notes || '',
          documentUrl: d['document-url'] || d['documentation-url'] || null, entity: d.entity }
      : { reference: r, name: r };
  });

  return result;
}

function featureToArea(f) {
  const p = f.properties || {};
  return {
    entity: p.entity ?? null, reference: p.reference ?? null, name: p.name ?? 'Article 4 area',
    direction: p['article-4-direction'] || null, startDate: p['start-date'] || null,
    notes: p.notes || p['permitted-development-rights'] || '',
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
function resultToRow(r) {
  const groupNames = (g) => r.designations.filter((d) => d.group === g)
    .map((d) => d.name ? `${d.label}: ${d.name}` : d.label).join('; ');
  const named = (ds) => r.designations.filter((d) => d.dataset === ds).map((d) => d.name || d.reference).join('; ');
  const a4 = r.article4;
  return {
    matched_location: r.location ? r.location.label : '',
    location_precision: r.location ? r.location.precision : '',
    latitude: r.location ? r.location.lat.toFixed(6) : '',
    longitude: r.location ? r.location.lon.toFixed(6) : '',
    easting: r.location && r.location.easting != null ? r.location.easting : '',
    northing: r.location && r.location.northing != null ? r.location.northing : '',
    in_kingston: yn(r.insideKingston),
    article4: a4.status === 'inside' ? 'Y' : a4.status === 'outside' ? 'N' : '',
    article4_borderline: yn(!!a4.borderline),
    article4_areas: a4.areas.map((a) => a.name).join('; '),
    article4_directions: a4.directions.map((d) => d.name && d.name !== d.reference ? `${d.reference} ${d.name}` : d.reference).join('; '),
    article4_check_method: a4.method || '',
    conservation_area: named('conservation-area'),
    listed_building_at_point: named('listed-building'),
    listed_buildings_nearby: r.nearby.filter((d) => d.dataset === 'listed-building').map((d) => d.name).join('; '),
    tree_preservation: groupNames('trees'),
    trees_nearby: r.nearby.filter((d) => d.group === 'trees').map((d) => d.name || d.reference).join('; '),
    flood_risk: r.designations.filter((d) => d.group === 'flood').map((d) => d.level ? `${d.label} ${d.level}` : d.label).join('; '),
    green_belt_open_land: groupNames('land'),
    heritage_other: r.designations.filter((d) => d.group === 'heritage' && !['conservation-area', 'listed-building'].includes(d.dataset))
      .map((d) => `${d.label}: ${d.name}`).join('; '),
    nature_environment: groupNames('nature'),
    plans_policy_sites: groupNames('policy'),
    other_designations: groupNames('other'),
    warnings: r.warnings.join(' | '),
    data_source: r.dataSource || (a4.method ? 'offline copy' : ''),
    checked_at: r.checkedAt,
  };
}


globalThis.A4Lookup = {
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
