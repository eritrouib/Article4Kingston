# Article 4 & Constraints Checker - Kingston upon Thames

A web tool to help Local Land Charges (LLC) officers at the Royal Borough of Kingston upon Thames check whether a property falls within an **Article 4 direction area**, and which other planning designations apply to it.

**Live site:** https://eritrouib.github.io/Article4Kingston/ (GitHub Pages, from the `main` branch root)

## What it does

- **Single property**: type an address, postcode, grid reference (`easting, northing`) or `lat, lon`, or click the map. You get:
  - a clear Article 4 verdict (inside / outside / part of plot / *borderline, verify*), with the direction(s), the rights removed and the area(s) that apply
  - the **HM Land Registry plot** (INSPIRE title polygon) at that point, drawn on the map, and everything that overlaps any part of it, not just the point
  - a **search checklist** of the questions an LLC search usually asks: Article 4, local development orders, conservation area, listed building, locally listed building, building preservation notice, certificate of immunity, scheduled monument, registered park or garden, archaeological priority area, heritage at risk, tree preservation orders, ancient woodland, flood zone, air quality management area, smoke control, contaminated land, green belt, common land, local green space, SSSI, local nature reserve, brownfield register, assets of community value and neighbourhood plan areas
  - listed buildings, protected trees and designation boundaries **within 10 to 50 m**, so edge cases aren't missed
  - a copyable text summary and a printable result for the search file
- **Batch (CSV)**: upload a list of properties and download a results CSV with one row per property and one column per checklist question. Original columns (UPRN, search reference, etc.) are kept. Recognised location columns:
  - `Easting`/`Northing` (or `X`/`Y`): best; export from the LLPG by UPRN
  - `Latitude`/`Longitude`
  - `Address` (or `Address1`, `Address2`, `Town`…) plus `Postcode`
  - `Postcode` alone (checks the postcode centre only)
- **Map layers** you can switch on (from the layers button on the map): conservation areas, listed buildings, tree preservation areas and protected trees (these two load ward by ward once you zoom in to street level), archaeological priority areas, scheduled monuments, green belt, brownfield land, flood zones 2 and 3, registered parks and gardens, SSSIs, local nature reserves, ancient woodland and wards.

### Checklist answers

| Answer | Meaning |
|---|---|
| Yes | Applies at the point |
| Part of plot | Applies to part of the Land Registry plot, not the point |
| Nearby | Within the chosen distance, but not on the plot |
| No | Nothing found, and this area does publish that type of data |
| Not published here | No such data is published for this area on Planning Data, so the tool can't answer. Check the council's own register |
| Not confirmed | Nothing found, but the tool couldn't confirm whether the data is published |
| Not checked | Live data was unavailable (only Article 4 is checked offline) |

"Not published here" is worked out per council, by asking Planning Data whether each dataset has any records in that local authority. As councils publish more data, those answers turn into Yes/No automatically.

## Where the data comes from

| What | Source |
|---|---|
| Article 4 areas & directions, conservation areas, listed buildings, TPO areas, flood zones, green belt, etc. | [planning.data.gov.uk](https://www.planning.data.gov.uk) (MHCLG Planning Data), queried live |
| Land Registry plots | HM Land Registry INSPIRE index polygons, via Planning Data |
| Postcode locations | [postcodes.io](https://postcodes.io) (ONS Postcode Directory) |
| Address matching | OpenStreetMap Nominatim, limited to the borough, 1 request/second |
| Borough boundary | London Datastore statistical GIS boundaries (OGL), in `data/` |
| Offline Article 4 backup | A saved copy of the official Planning Data boundaries, refreshed monthly (see below) |

Kingston publishes its Article 4 data to Planning Data: currently three directions — **Seething Wells Filter Beds (2021)**, **commercial, business and service to residential (Aug 2022)**, and **North Lodge and South Lodge (2023)** — across ~114 mapped areas. The original version of this repo only had the 2022 direction as four merged polygons, so it would have missed the other two.

## How a result is reached

1. The location is resolved (coordinates as given; postcode centre; or an address match).
2. A point query to Planning Data returns every designation containing the point.
3. A second query over a small square around the point finds things *near* the property (listed buildings, trees, boundaries running close by).
4. The Article 4 answer is cross-checked against Kingston's Article 4 boundaries downloaded at page load; disagreements are flagged.
5. If Planning Data can't be reached, the Article 4 check uses the saved copy of the official boundaries, and the result says so and shows the date it was saved.

## Important limits

- This is an **aid**. It does not replace the statutory LLC Register or the council's own GIS. Confirm positive and borderline results against the direction documents.
- A **postcode centre** can fall in a different designation from some properties in that postcode. Use grid references or full addresses for formal searches.
- Results are only as complete as what each publisher has supplied to Planning Data. Check [Kingston's data page](https://www.planning.data.gov.uk/organisation/local-authority:KTT) for coverage — e.g. if locally listed buildings or individual TPO trees are missing, they won't appear.
- Easting/northing are converted with a standard 7-parameter transform (accurate to a few metres); the borderline tolerance covers this.

## Project layout

```
index.html                 page
css/app.css                styles (incl. print and mobile layout)
js/data.js                 bundled copy of data/ (generated)
js/lookup.js               parsing, geocoding, Planning Data queries, geometry, CSV mapping (no DOM)
js/app.js                  map, single-search and batch UI
data/kingston-boundary.geojson
data/article4-official.geojson     saved copy of the official Article 4 boundaries (generated)
data/article4-legacy-2022.geojson  original hand-digitised 2022 polygons, used only until a saved copy exists
scripts/update_offline_data.py     downloads the official boundaries into the saved copy
.github/workflows/update-data.yml  runs that script monthly on GitHub
tests/lookup.test.js       unit tests (mocked APIs)
```

## Keeping the offline backup up to date

The backup is only used when Planning Data is unreachable, but it should still match the official boundaries.

- **On GitHub (nothing to install):** go to the repo's **Actions** tab → **Update offline Article 4 data** → **Run workflow**. It also runs by itself on the 1st of every month and commits only if something changed.
- **On your computer:** with Python 3 installed, run `python scripts/update_offline_data.py` in the repo folder, then commit and push.

If GitHub Actions can't push, enable it under Settings → Actions → General → Workflow permissions → "Read and write permissions".

## Running it

No installation or build is needed.

- **On your computer:** double-click `index.html`. It opens in your browser and works as long as you are online (it needs the map tiles and the live planning data).
- **For colleagues:** push to GitHub with Pages enabled (Settings → Pages → Deploy from branch → `main`, `/ (root)`), and share the link.

If your council network blocks `planning.data.gov.uk`, `api.postcodes.io` or `cdn.jsdelivr.net`, the page will say so in the status pill at the top; ask IT to allow those sites.

## Development

```
npm install
npm test                 # unit tests
npm run build-data       # regenerate js/data.js after hand-editing anything in data/
```

The scripts are plain (non-module) JavaScript so the page also works when opened from disk.

## Licence & attribution

Created by **@ET**.


Contains public sector information licensed under the Open Government Licence v3.0. Contains OS data © Crown copyright and database right. Map data © OpenStreetMap contributors; imagery © Esri.

Land Registry plots: This information is subject to Crown copyright and database rights 2026 and is reproduced with the permission of HM Land Registry. The polygons (including the associated geometry, namely x, y co-ordinates) are subject to Crown copyright and database rights 2026 Ordnance Survey AC0000851063.
