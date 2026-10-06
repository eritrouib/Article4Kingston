import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import {
  parseQuery, normalisePostcode, geocode, checkLocation, checkAgainstFeatures,
  pointInGeometry, distanceToBoundary, bufferWkt, detectColumns, rowToQuery, resultToRow,
  bngToLatLon, latLonToBng,
} from '../js/lookup.js';

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
const directions = {
  A4D2: { entity: 1, reference: 'A4D2', name: 'Commercial, business and service use to residential', 'start-date': '2022-07-31' },
};

test('live check: inside Article 4, with designations and nearby listed building', async () => {
  const fetch = mockFetch([
    [/geometry=POLYGON/, { entities: [a4Entity, caEntity, lbEntity], links: {} }],
    [/latitude=/, { entities: [a4Entity, caEntity, endedCa], links: {} }],
  ]);
  const loc = { ...INSIDE, label: 'test', precision: 'address', source: 'test' };
  const r = await checkLocation(loc, { fetch, a4Directions: directions, legacyA4: legacy, boundary, nearMetres: 25 });
  assert.equal(r.article4.status, 'inside');
  assert.equal(r.article4.method, 'live');
  assert.equal(r.article4.directions[0].name, directions.A4D2.name);
  assert.equal(r.insideKingston, true);
  assert.deepEqual(r.designations.map((d) => d.name), ['Kingston Old Town'], 'ended designation dropped');
  assert.deepEqual(r.nearby.map((d) => d.name), ['The Guildhall'], 'nearby excludes things already at point');
  const row = resultToRow(r);
  assert.equal(row.article4, 'Y');
  assert.equal(row.conservation_area, 'Kingston Old Town');
  assert.equal(row.listed_buildings_nearby, 'The Guildhall');
});

test('live check: outside but near an Article 4 boundary is flagged borderline', async () => {
  const fetch = mockFetch([
    [/geometry=POLYGON/, { entities: [a4Entity], links: {} }],
    [/latitude=/, { entities: [], links: {} }],
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
    [/geometry=POLYGON/, { entities: [], links: {} }],
    [/latitude=/, { entities: [], links: {} }],
  ]);
  // Downloaded areas say "inside" (legacy geometry relabelled as live), API says outside.
  const fakeLive = { type: 'FeatureCollection', features: legacy.features.map((f, i) => ({ ...f, properties: { ...f.properties, entity: 900 + i } })) };
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, { fetch, a4Areas: fakeLive, legacyA4: legacy, boundary });
  assert.ok(r.warnings.some((w) => /disagree/.test(w)));
});

test('pagination follows links.next', async () => {
  let n = 0;
  const fetch = mockFetch([
    [/geometry=POLYGON/, { entities: [], links: {} }],
    [/offset=100/, { entities: [caEntity], links: {} }],
    [/latitude=/, () => { n++; return { entities: [a4Entity], links: { next: '/entity.json?latitude=1&offset=100' } }; }],
  ]);
  const r = await checkLocation({ ...INSIDE, label: 't', precision: 'exact' }, { fetch, legacyA4: legacy, boundary });
  assert.equal(r.designations.length, 1);
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
