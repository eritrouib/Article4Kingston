# Article 4 & Constraints Checker — Kingston upon Thames

A web tool to help Local Land Charges (LLC) officers at the Royal Borough of Kingston upon Thames check whether a property falls within an **Article 4 direction area**, and which other planning designations apply to it.

**Live site:** https://eritrouib.github.io/Article4Kingston/ (GitHub Pages, from the `main` branch root)

## What it does

- **Single property** — type an address, postcode, grid reference (`easting, northing`) or `lat, lon`, or click the map. You get:
  - a clear Article 4 verdict (inside / outside / *borderline – verify*), with the direction(s) and area(s) that apply
  - every other designation at that point: conservation areas, listed buildings, tree preservation areas, flood risk zones, green belt, SSSIs, scheduled monuments, archaeological priority areas, brownfield sites and more
  - listed buildings, protected trees and designation boundaries **within 10–50 m** of the point, so edge cases aren't missed
  - a copyable text summary and a printable result for the search file
- **Batch (CSV)** — upload a list of properties and download a results CSV with one row per property. Original columns (UPRN, search reference, etc.) are kept. Recognised location columns:
  - `Easting`/`Northing` (or `X`/`Y`) — best; export from the LLPG by UPRN
  - `Latitude`/`Longitude`
  - `Address` (or `Address1`, `Address2`, `Town`…) plus `Postcode`
  - `Postcode` alone (checks the postcode centre only)

## Where the data comes from

| What | Source |
|---|---|
| Article 4 areas & directions, conservation areas, listed buildings, TPO areas, flood zones, green belt, etc. | [planning.data.gov.uk](https://www.planning.data.gov.uk) (MHCLG Planning Data), queried live |
| Postcode locations | [postcodes.io](https://postcodes.io) (ONS Postcode Directory) |
| Address matching | OpenStreetMap Nominatim, limited to the borough, 1 request/second |
| Borough boundary, offline Article 4 fallback | `data/` in this repo (recovered from the original 2022 shapefiles) |

Kingston publishes its Article 4 data to Planning Data: currently three directions — **Seething Wells Filter Beds (2021)**, **commercial, business and service to residential (Aug 2022)**, and **North Lodge and South Lodge (2023)** — across ~114 mapped areas. The original version of this repo only had the 2022 direction as four merged polygons, so it would have missed the other two.

## How a result is reached

1. The location is resolved (coordinates as given; postcode centre; or an address match).
2. A point query to Planning Data returns every designation containing the point.
3. A second query over a small square around the point finds things *near* the property (listed buildings, trees, boundaries running close by).
4. The Article 4 answer is cross-checked against Kingston's Article 4 boundaries downloaded at page load; disagreements are flagged.
5. If Planning Data can't be reached, the Article 4 check falls back to `data/article4-legacy-2022.geojson` and the result says so clearly.

## Important limits

- This is an **aid**. It does not replace the statutory LLC Register or the council's own GIS. Confirm positive and borderline results against the direction documents.
- A **postcode centre** can fall in a different designation from some properties in that postcode. Use grid references or full addresses for formal searches.
- Results are only as complete as what each publisher has supplied to Planning Data. Check [Kingston's data page](https://www.planning.data.gov.uk/organisation/local-authority:KTT) for coverage — e.g. if locally listed buildings or individual TPO trees are missing, they won't appear.
- Easting/northing are converted with a standard 7-parameter transform (accurate to a few metres); the borderline tolerance covers this.

## Project layout

```
index.html                 page
css/app.css                styles (incl. print and mobile layout)
js/lookup.js               parsing, geocoding, Planning Data queries, geometry, CSV mapping (no DOM)
js/app.js                  map, single-search and batch UI
data/kingston-boundary.geojson
data/article4-legacy-2022.geojson   offline fallback (recovered from the original shapefiles)
tests/lookup.test.js       unit tests (mocked APIs)
```

## Development

It's a static site — no build step. To run locally, serve the folder (ES modules need http, not `file://`):

```
python -m http.server 8000
# open http://localhost:8000
```

Tests:

```
npm install
npm test
```

## Licence & attribution

Contains public sector information licensed under the Open Government Licence v3.0. Contains OS data © Crown copyright and database right. Map data © OpenStreetMap contributors; imagery © Esri.
