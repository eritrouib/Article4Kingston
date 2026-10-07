import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import '../js/lookup.js'; // plain script: sets globalThis.A4Lookup

const {
  parseQuery, normalisePostcode, geocode, checkLocation, checkAgainstFeatures,
  pointInGeometry, distanceToBoundary, bufferWkt, detectColumns, rowToQuery, resultToRow,
  bngToLatLon, latLonToBng,
} = globalThis.A4Lookup;

const legacy = JSON.parse(readFileSync(new URL('../data/article4-legacy-2022.geojson', import.meta.url)));
const boundary = JSON.parse(readFileSync(new URL('../data/kingston-boundary.geojson', import.meta.url)));

// A point inside legacy area 1 (Kingston town centre) and one well outside all areas.
const INSIDE = { lat: 51.409138, lon: -0.304916 };
const OUTSIDE = { lat: 51.3700, lon: -0.2950 }; // Tolworth/Hook residential, inside the borough

function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [pattern, body] of routes) {
      if (pattern.test(url)) {
        const value = typeof body === 'function' ? body(url) : body;
        if (value instanceof Error) throw value;
        if (value && value.__status) return { ok: false, status: value.__status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => value };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

test('parseQuery recognises input types', () => {
  assert.equal(parseQuery('kt1 1eu').type, 'postcode');
  assert.equal(parseQuery('KT11EU').postcode, 'KT1 1EU');
  assert.deepEqual(
    { ...parseQuery('518000, 169000') }, { type: 'bng', easting: 518000, northing: 169000, text: '518000, 169000' });
  assert.equal(parseQuery('51.41, -0.30').type, 'latlon');
  const swapped = parseQuery('-0.30, 51.41');
  assert.equal(swapped.lat, 51.41);
  assert.equal(swapped.lon, -0.30);
  const addr = parseQuery('Guildhall, High Street, Kingston upon Thames KT1 1EU');
  assert.equal(addr.type, 'address');
  assert.equal(addr.postcode, 'KT1 1EU');
  assert.equal(parseQuery('  ').type, 'empty');
  assert.equal(normalisePostcode('not a postcode'), null);
});

test('BNG conversion round-trips within a metre', () => {
  const { lat, lon } = bngToLatLon(proj4, 518000, 169000);
  assert.ok(lat > 51.3 && lat < 51.5 && lon > -0.35 && lon < -0.2);
  const back = latLonToBng(proj4, lat, lon);
  assert.ok(Math.abs(back.easting - 518000) <= 1 && Math.abs(back.northing - 169000) <= 1);
});

test('point in polygon and distances against recovered data', () => {
  const area1 = legacy.features[0].geometry;
  assert.ok(pointInGeometry(INSIDE.lat, INSIDE.lon, area1));
  assert.ok(!pointInGeometry(OUTSIDE.lat, OUTSIDE.lon, area1));
  assert.ok(distanceToBoundary(INSIDE.lat, INSIDE.lon, area1) > 0);
  const r = checkAgainstFeatures(OUTSIDE.lat, OUTSIDE.lon, legacy, 25);
  assert.equal(r.inside.length, 0);
  assert.ok(checkAgainstFeatures(INSIDE.lat, INSIDE.lon, boundary).inside.length === 1, 'town centre is in Kingston');
  assert.ok(checkAgainstFeatures(51.5074, -0.1278, boundary).inside.length === 0, 'Charing Cross is not');
});

test('bufferWkt builds a closed square', () => {
  const w = bufferWkt(51.4, -0.3, 25);
  assert.match(w, /^POLYGON\(\(/);
  const pts = w.slice(9, -2).split(',');
  assert.equal(pts.length, 5);
  assert.equal(pts[0], pts[4]);
});

const a4Entity = {
  entity: 7010010324, dataset: 'article-4-direction-area', name: 'Canbury Park LSIS A4D area', reference: '1',
  'article-4-direction': 'A4D2', 'start-date': '2022-08-01', 'end-date': '', 'organisation-entity': '188',
};
const caEntity = { entity: 44000001, dataset: 'conservation-area', name: 'Kingston Old Town', reference: 'CA1', 'end-date': '' };
const endedCa = { entity: 44000002, dataset: 'conservation-area', name: 'Abolished CA', reference: 'CA9', 'end-date': '2001-01-01' };
const lbEntity = { entity: 31000001, dataset: 'listed-building', name: 'The Guildhall', reference: '1080000', 'listed-building-grade': 'II', 'end-date': '' };
const lad = { entity: 8600304, dataset: 'local-authority-district', name: 'Kingston upon Thames', reference: 'E09000021', 'end-date': '' };
const ward = { entity: 804836, dataset: 'ward', name: 'Kingston Town', reference: 'E05013938', 'end-date': '' };
const nonAdmin = (list) => list.filter((d) => d.group !== 'admin');
const directions = {
  A4D2: { entity: 1, reference: 'A4D2', name: 'Commercial, business and service use to residential', 'start-date': '2022-07-31' },
};

test('live check: inside Article 4, with designations and nearby listed building', async () => {
  const fetch = mockFetch([
    [/geometry=POLYGON/, { entities: [lad, a4Entity, caEntity, lbEntity], links: {} }],
    [/latitude=/, { entities: [lad, ward, a4Entity, caEntity, endedCa], links: {} }],
    [/dataset=conservation-area&geometry_entity=8600304/, { entities: [{ entity: 1, dataset: 'conservation-area' }], count: 28 }],
    [/dataset=listed-building&geometry_entity=8600304/, { entities: [{ entity: 2, dataset: 'listed-building' }], count: 163 }],
    [/dataset=smoke-control-area/, { __status: 422 }],
  ]);
  const loc = { ...INSIDE, label: 'test', precision: 'address', source: 'test' };
  const r = await checkLocation(loc, { fetch, a4Directions: directions, legacyA4: legacy, boundary, nearMetres: 25 });
  assert.equal(r.article4.status, 'inside');
  assert.equal(r.article4.method, 'live');
  assert.equal(r.article4.directions[0].name, directions.A4D2.name);
  assert.equal(r.insideKingston, true);
  assert.deepEqual(nonAdmin(r.designations).map((d) => d.name), ['Kingston Old Town'], 'ended designation dropped');
  assert.deepEqual(r.nearby.map((d) => d.name), ['The Guildhall'], 'nearby excludes things already at point');
  assert.equal(r.ward, 'Kingston Town');
  const byId = Object.fromEntries(r.checklist.map((c) => [c.id, c]));
  assert.equal(byId.article4.status, 'yes');
  assert.equal(byId.conservation.status, 'yes');
  assert.equal(byId.listed.status, 'near');
  assert.equal(byId.smoke.status, 'not_published', '422 = dataset not available');
  assert.equal(byId.green_belt.status, 'not_published', '404/empty = none published');
  const row = resultToRow(r);
  assert.equal(row.article4, 'Y');
  assert.equal(row.conservation, 'Y: Kingston Old Town');
  assert.equal(row.listed, 'NEARBY: The Guildhall (Grade II) [nearby]');
  assert.equal(row.smoke, 'NOT PUBLISHED');
});

test('live check: outside but near an Article 4 boundary is flagged borderline', async () => {
  const fetch = mockFetch([
    [/geometry=POLYGON/, { entities: [lad, a4Entity], links: {} }],
    [/latitude=/, { entities: [lad], links: {} }],
  ]);
  const r = await checkLocation({ ...OUTSIDE, label: 't', precision: 'postcode' }, { fetch, legacyA4: legacy, boundary });
  assert.equal(r.article4.status, 'outside');
  assert.equal(r.article4.borderline, true);
  assert.ok(r.warnings.some((w) => /postcode centre/.test(w)));
});

test('offline fallback uses legacy polygons and says so', async () => {
  const fetch = mockFetch([[/planning\.data/, new Error('network down')]]);
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, { fetch, legacyA4: legacy, boundary });
  assert.equal(r.article4.status, 'inside');
  assert.equal(r.article4.method, 'offline-legacy');
  assert.ok(r.warnings.some((w) => /could not be reached/.test(w)));
  assert.ok(r.warnings.some((w) => /Seething Wells/.test(w)));
  const r2 = await checkLocation({ ...OUTSIDE, label: 't', precision: 'exact' }, { fetch, legacyA4: legacy, boundary });
  assert.equal(r2.article4.status, 'outside');
});

test('disagreement between live point query and downloaded boundaries is flagged', async () => {
  const fetch = mockFetch([
    [/geometry=POLYGON/, { entities: [lad], links: {} }],
    [/latitude=/, { entities: [lad], links: {} }],
  ]);
  // Downloaded areas say "inside" (legacy geometry relabelled as live), API says outside.
  const fakeLive = { type: 'FeatureCollection', features: legacy.features.map((f, i) => ({ ...f, properties: { ...f.properties, entity: 900 + i } })) };
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, { fetch, a4Areas: fakeLive, legacyA4: legacy, boundary });
  assert.ok(r.warnings.some((w) => /disagree/.test(w)));
});

test('pagination follows links.next', async () => {
  let n = 0;
  const fetch = mockFetch([
    [/geometry=POLYGON/, { entities: [lad], links: {} }],
    [/offset=100/, { entities: [caEntity], links: {} }],
    [/latitude=/, () => { n++; return { entities: [lad, a4Entity], links: { next: '/entity.json?latitude=1&offset=100' } }; }],
  ]);
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, { fetch, legacyA4: legacy, boundary });
  assert.equal(nonAdmin(r.designations).length, 1);
  assert.equal(n, 1);
});

test('geocode postcode, terminated postcode, and address via Nominatim', async () => {
  const fetch = mockFetch([
    [/postcodes\/KT1%201EU/, { result: { latitude: 51.41, longitude: -0.3, admin_district: 'Kingston upon Thames', eastings: 517900, northings: 169100 } }],
    [/terminated_postcodes\/KT9%209ZZ/, { result: { latitude: 51.36, longitude: -0.3 } }],
    [/nominatim.*Guildhall/, [{ lat: '51.4085', lon: '-0.3061', display_name: 'Guildhall, High Street', type: 'townhall', address: { house_number: '1', postcode: 'KT1 1EU' } }]],
    [/nominatim/, []],
  ]);
  const a = await geocode(parseQuery('KT1 1EU'), { fetch });
  assert.equal(a.precision, 'postcode');
  assert.equal(a.easting, 517900);
  const b = await geocode(parseQuery('KT9 9ZZ'), { fetch });
  assert.ok(b.warnings[0].includes('terminated'));
  const c = await geocode(parseQuery('Guildhall, High Street, Kingston'), { fetch });
  assert.equal(c.precision, 'address');
  const d = await geocode(parseQuery('Nowhere Lane KT1 1EU'), { fetch });
  assert.equal(d.precision, 'postcode', 'falls back to postcode');
  await assert.rejects(geocode(parseQuery('Nowhere Lane'), { fetch }), /not found/);
});

test('CSV column detection and row parsing', () => {
  const cols = detectColumns(['UPRN', 'Address', 'Post Code', 'X', 'Y']);
  assert.equal(cols.address, 'Address');
  assert.equal(cols.postcode, 'Post Code');
  assert.equal(cols.easting, 'X');
  assert.equal(rowToQuery({ UPRN: '1', Address: '1 High St', 'Post Code': 'KT1 1EU', X: '517900', Y: '169100' }, cols).type, 'bng');
  const q = rowToQuery({ UPRN: '1', Address: '1 High St', 'Post Code': 'kt11eu', X: '', Y: '' }, cols);
  assert.equal(q.type, 'address');
  assert.equal(q.text, '1 High St, kt11eu');
  assert.equal(q.postcode, 'KT1 1EU');
  const pcOnly = rowToQuery({ Address: '', 'Post Code': 'KT1 1EU', X: '', Y: '' }, cols);
  assert.equal(pcOnly.type, 'postcode');
  const parts = detectColumns(['Address1', 'Address2', 'Town', 'Postcode']);
  assert.deepEqual(parts.addressParts, ['Address1', 'Address2', 'Town']);
  assert.equal(rowToQuery({ Address1: '1 High St', Address2: '', Town: 'Kingston', Postcode: 'KT1 1EU' }, parts).text, '1 High St, Kingston, KT1 1EU');
});

test('offline fallback prefers the saved official copy over the 2022 polygons', async () => {
  const fetch = mockFetch([[/planning\.data/, new Error('network down')]]);
  const snapshot = {
    type: 'FeatureCollection',
    metadata: { downloaded: '2026-10-01T06:17:00+00:00' },
    features: legacy.features.map((f, i) => ({
      ...f, properties: { entity: 7010010324 + i, name: `Official area ${i + 1}`, 'article-4-direction': 'A4D2' },
    })),
  };
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, {
    fetch, offlineA4: snapshot, legacyA4: legacy, boundary, a4Directions: directions,
  });
  assert.equal(r.article4.method, 'offline-snapshot');
  assert.equal(r.article4.status, 'inside');
  assert.equal(r.article4.areas[0].name, 'Official area 1');
  assert.equal(r.article4.directions[0].name, directions.A4D2.name);
  assert.ok(r.warnings.some((w) => /saved in this tool on 2026-10-01/.test(w)));
  assert.ok(!r.warnings.some((w) => /Seething Wells/.test(w)), 'no legacy warning');
});

// Real records from planning.data.gov.uk (Oct 2026): the areas' "article-4-direction"
// field holds the area's own number, so links must come from the descriptions.
const KINGSTON_DIRECTIONS = {
  A4D1: { entity: 1, reference: 'A4D1', name: 'Seething Wells Filter Bed', 'start-date': '2021-04-14' },
  A4D2: { entity: 2, reference: 'A4D2', name: 'Commercial, business and service use to residential use', 'start-date': '2022-07-31' },
  A4D3: { entity: 3, reference: 'A4D3', name: 'North Lodge and South Lodge', 'start-date': '2023-08-29' },
};
const KINGSTON_AREAS = [
  { name: 'Canbury Park LSIS A4D area', direction: '1', notes: 'Article 4 Direction for commercial, business and service use to residential use', want: 'A4D2' },
  { name: 'Seething Wells Filter Beds', direction: '112', notes: 'Article 4 Direction at Seething Wells Filter Beds', want: 'A4D1' },
  { name: 'North Lodge', direction: '113', notes: 'Article 4 Direction for North Lodge and South Lodge', want: 'A4D3' },
  { name: 'South Lodge', direction: '114', notes: 'Article 4 Direction for North Lodge and South Lodge', want: 'A4D3' },
];

test('areas are linked to the right direction from their descriptions', () => {
  const { linkDirection } = globalThis.A4Lookup;
  for (const a of KINGSTON_AREAS) {
    assert.deepEqual(linkDirection(a, KINGSTON_DIRECTIONS), { ref: a.want, how: 'matched' }, a.name);
  }
  assert.deepEqual(linkDirection({ direction: 'A4D2' }, KINGSTON_DIRECTIONS), { ref: 'A4D2', how: 'published' });
  assert.deepEqual(linkDirection({ direction: '7', notes: 'Something unrelated' }, KINGSTON_DIRECTIONS), { ref: null, how: null });
});

test('result names the direction and lists the rights removed', async () => {
  const seething = {
    entity: 7010010435, dataset: 'article-4-direction-area', name: 'Seething Wells Filter Beds', reference: '112',
    'article-4-direction': '112', notes: 'Article 4 Direction at Seething Wells Filter Beds', 'end-date': '',
    'permitted-development-rights': 'Removes permitted development rights to erect fencing, gates and other means of enclosure on the site.',
  };
  const fetch = mockFetch([[/geometry=POLYGON/, { entities: [lad], links: {} }], [/latitude=/, { entities: [lad, seething], links: {} }]]);
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, { fetch, a4Directions: KINGSTON_DIRECTIONS, legacyA4: legacy, boundary });
  assert.equal(r.article4.directions[0].reference, 'A4D1');
  assert.equal(r.article4.directions[0].name, 'Seething Wells Filter Bed');
  assert.match(r.article4.restrictions[0], /fencing, gates/);
  const row = resultToRow(r);
  assert.equal(row.article4_directions, 'A4D1 Seething Wells Filter Bed');
  assert.match(row.article4_rights_removed, /fencing/);
});

// ---------------------------------------------------------------------------
// Land Registry plot, unreliable answers, coverage
// ---------------------------------------------------------------------------
function squareAround(lat, lon, metres) {
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.cos((lat * Math.PI) / 180));
  return { type: 'MultiPolygon', coordinates: [[[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]]] };
}

test('geometryArea measures a 20 m square as ~400 m2', () => {
  const { geometryArea } = globalThis.A4Lookup;
  const a = geometryArea(squareAround(51.4, -0.3, 10));
  assert.ok(Math.abs(a - 400) < 5, String(a));
});

test('wktParam escapes only spaces by default', () => {
  const { wktParam } = globalThis.A4Lookup;
  assert.equal(wktParam('POLYGON((1 2,3 4))'), 'POLYGON((1%202,3%204))');
  assert.equal(wktParam('POLYGON((1 2,3 4))', 'encoded'), 'POLYGON((1%202%2C3%204))');
});

test('plot check: Article 4 and listed outline on the plot but not the point', async () => {
  const smallTitle = { entity: 12000000001, dataset: 'title-boundary', reference: '111', 'end-date': '' };
  const bigTitle = { entity: 12000000002, dataset: 'title-boundary', reference: '222', 'end-date': '' };
  const outline = { entity: 31500001, dataset: 'listed-building-outline', name: '3-5 Apple Market', 'end-date': '' };
  const fetch = mockFetch([
    [/entity\/12000000001\.geojson/, { type: 'Feature', geometry: squareAround(OUTSIDE.lat, OUTSIDE.lon, 8) }],
    [/entity\/12000000002\.geojson/, { type: 'Feature', geometry: squareAround(OUTSIDE.lat, OUTSIDE.lon, 80) }],
    [/geometry_relation=overlaps&geometry_entity=12000000001/, { entities: [a4Entity, bigTitle], count: 2 }],
    [/geometry_relation=within&geometry_entity=12000000001/, { entities: [outline], count: 1 }],
    [/geometry_relation=contains&geometry_entity=12000000001/, { entities: [lad], count: 1 }],
    [/geometry=POLYGON/, { entities: [lad], links: {} }],
    [/latitude=/, { entities: [lad, smallTitle, bigTitle], links: {} }],
  ]);
  const r = await checkLocation({ ...OUTSIDE, label: 't', precision: 'exact' }, { fetch, a4Directions: directions, legacyA4: legacy, boundary });
  assert.equal(r.plot.inspireId, '111', 'smallest title containing the point is used');
  assert.ok(Math.abs(r.plot.areaM2 - 256) < 5);
  assert.equal(r.article4.status, 'plot');
  assert.equal(r.article4.borderline, true);
  assert.ok(r.article4.areas[0].onPlot);
  assert.ok(r.warnings.some((w) => /part of the Land Registry plot/.test(w)));
  const listed = r.checklist.find((c) => c.id === 'listed');
  assert.equal(listed.status, 'plot');
  const row = resultToRow(r);
  assert.equal(row.article4, 'PART OF PLOT');
  assert.equal(row.land_registry_inspire_id, '111');
  assert.equal(row.listed, 'PART OF PLOT: 3-5 Apple Market [plot]');
});

test('CSV cell lists plot and nearby records after the point ones', () => {
  const { checklistCell } = globalThis.A4Lookup;
  const cell = checklistCell({ status: 'yes', items: [
    { name: 'Flood zone 3', where: 'plot' }, { name: 'Flood zone 2', where: 'point' }, { name: 'Flood zone 2', where: 'point' },
  ] });
  assert.equal(cell, 'Y: Flood zone 2; Flood zone 3 [plot]');
});

test('nearby check that ignores the location filter is discarded with a warning', async () => {
  const bogus = { entities: [{ entity: 1, dataset: 'local-authority', typology: 'organisation', name: 'Somewhere' }], count: 25000000 };
  const fetch = mockFetch([
    [/geometry=POLYGON/, bogus],
    [/latitude=/, { entities: [lad, caEntity], links: {} }],
  ]);
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, { fetch, legacyA4: legacy, boundary });
  assert.equal(r.nearby.length, 0);
  assert.ok(r.warnings.some((w) => /could not be checked this time/.test(w)));
  assert.equal(fetch.calls.filter((u) => /geometry=POLYGON/.test(u)).length, 2, 'retried with the other encoding');
  assert.ok(fetch.calls.some((u) => /geometry=POLYGON\(\(/.test(u)), 'first try keeps brackets unescaped');
});

test('point answer without the borough falls back to offline Article 4 check', async () => {
  const fetch = mockFetch([
    [/geometry=POLYGON/, { entities: [lad] }],
    [/latitude=/, { entities: [{ entity: 7, dataset: 'local-authority', typology: 'organisation' }] }],
  ]);
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, { fetch, legacyA4: legacy, boundary });
  assert.equal(r.article4.method, 'offline-legacy');
  assert.equal(r.article4.status, 'inside');
  assert.ok(r.checklist.filter((c) => c.id !== 'article4').every((c) => c.status === 'unchecked'));
});

test('coverage: published, none, missing dataset, and unknown', async () => {
  const { fetchCoverage } = globalThis.A4Lookup;
  const fetch = mockFetch([
    [/dataset=conservation-area&/, { entities: [{ entity: 1, dataset: 'conservation-area' }], count: 28 }],
    [/dataset=green-belt&/, { entities: [], count: 0 }],
    [/dataset=smoke-control-area&/, { __status: 422 }],
    [/dataset=tree&/, new Error('network')],
    [/dataset=ward&/, { entities: [{ entity: 9, dataset: 'local-authority' }], count: 25000000 }],
  ]);
  const cov = await fetchCoverage(fetch, 8600304, ['conservation-area', 'green-belt', 'smoke-control-area', 'tree', 'ward']);
  assert.deepEqual(cov, { 'conservation-area': true, 'green-belt': false, 'smoke-control-area': false, tree: null, ward: null });
});

test('coverage is fetched once per borough and reused', async () => {
  let coverageCalls = 0;
  const fetch = mockFetch([
    [/geometry_entity=8600304/, () => { coverageCalls++; return { entities: [], count: 0 }; }],
    [/geometry=POLYGON/, { entities: [lad] }],
    [/latitude=/, { entities: [lad] }],
  ]);
  const deps = { fetch, legacyA4: legacy, boundary, coverageCache: new Map() };
  await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, deps);
  const first = coverageCalls;
  await checkLocation({ ...OUTSIDE, label: 't', precision: 'exact' }, deps);
  assert.ok(first > 10);
  assert.equal(coverageCalls, first);
});
