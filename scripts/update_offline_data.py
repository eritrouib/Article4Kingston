#!/usr/bin/env python3
"""
Download Kingston's official Article 4 boundaries from planning.data.gov.uk and
save them as the tool's offline copy.

This copy is only used when the live Planning Data service can't be reached.
It replaces the hand-digitised 2022 polygons in data/article4-legacy-2022.geojson.

Run it from the repository folder:

    python scripts/update_offline_data.py

It needs only a standard Python 3.8+ install, no extra packages.
It writes:
    data/article4-official.geojson   the official boundaries + direction details
    js/data.js                       the same data bundled for the web page

It also runs automatically on GitHub once a month (.github/workflows/update-data.yml).
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

API = os.environ.get("PLANNING_API", "https://www.planning.data.gov.uk").rstrip("/")
ORG_ENTITY = 188  # Royal Borough of Kingston upon Thames
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT_GEOJSON = DATA / "article4-official.geojson"
OUT_JS = ROOT / "js" / "data.js"

KEEP_PROPS = [
    "entity", "reference", "name", "article-4-direction", "start-date", "end-date",
    "notes", "permitted-development-rights", "organisation-entity", "entry-date",
]
KEEP_DIRECTION = [
    "entity", "reference", "name", "start-date", "end-date", "description", "notes",
    "document-url", "documentation-url", "organisation-entity",
]


def get_json(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "Article4Kingston offline-data updater (github.com/eritrouib/Article4Kingston)",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def absolute(link):
    return link if link.startswith("http") else API + link


def fetch_all(path, params, key):
    """Fetch every page of an entity search, following links.next."""
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    items = []
    for _ in range(50):
        page = get_json(url)
        batch = page.get(key) or []
        items.extend(batch)
        nxt = (page.get("links") or {}).get("next")
        if not nxt or not batch:
            break
        url = absolute(nxt)
    return items


def is_current(props, today):
    end = props.get("end-date") or ""
    return not end or end > today


LINK_STOP = {"article", "direction", "directions", "for", "the", "and", "use", "uses", "area", "areas",
             "a4d", "removes", "permitted", "development", "rights", "right", "change", "with", "from",
             "this", "that", "site", "sites"}


def link_words(text):
    words = re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).split()
    return {re.sub(r"s$", "", w) for w in words if len(w) > 2 and w not in LINK_STOP}


def link_direction(props, directions):
    """Which direction an area belongs to. Same rule as linkDirection() in js/lookup.js:
    Kingston's "article-4-direction" field holds the area number, not A4D1/2/3, so
    fall back to matching the area's description against the direction names."""
    declared = str(props.get("article-4-direction") or "")
    if declared in directions:
        return declared
    area_words = link_words(f"{props.get('notes', '')} {props.get('name', '')}")
    scores = sorted(((len(link_words(d.get("name")) & area_words), ref) for ref, d in directions.items()), reverse=True)
    if scores and scores[0][0] >= 2 and (len(scores) == 1 or scores[1][0] < scores[0][0]):
        return scores[0][1]
    return None


def round_coords(obj, places=7):
    if isinstance(obj, list):
        return [round_coords(x, places) for x in obj]
    if isinstance(obj, float):
        return round(obj, places)
    return obj


def main():
    today = date.today().isoformat()
    print(f"Downloading Article 4 areas for organisation {ORG_ENTITY} from {API} ...")
    features = fetch_all("entity.geojson", {
        "dataset": "article-4-direction-area",
        "organisation_entity": ORG_ENTITY,
        "limit": 500,
    }, "features")

    kept = []
    for f in features:
        props = f.get("properties") or {}
        geom = f.get("geometry")
        if not geom or not is_current(props, today):
            continue
        geom = dict(geom, coordinates=round_coords(geom.get("coordinates")))
        kept.append({
            "type": "Feature",
            "properties": {k: props.get(k) for k in KEEP_PROPS if props.get(k) not in (None, "")},
            "geometry": geom,
        })
    kept.sort(key=lambda f: (str(f["properties"].get("article-4-direction", "")),
                             str(f["properties"].get("reference", "")).zfill(6)))

    print("Downloading Article 4 directions ...")
    directions = {}
    for d in fetch_all("entity.json", {
        "dataset": "article-4-direction",
        "organisation_entity": ORG_ENTITY,
        "limit": 100,
    }, "entities"):
        ref = d.get("reference")
        if ref:
            directions[ref] = {k: d.get(k) for k in KEEP_DIRECTION if d.get(k) not in (None, "")}

    if not kept:
        sys.exit("No Article 4 areas came back, so the saved copy was left unchanged. Try again later.")

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "source": f"{API} (dataset article-4-direction-area, organisation-entity {ORG_ENTITY})",
            "downloaded": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "licence": "Open Government Licence v3.0",
            "areas": len(kept),
            "directions": len(directions),
        },
        "directions": directions,
        "features": kept,
    }

    old = None
    if OUT_GEOJSON.exists():
        try:
            old = json.loads(OUT_GEOJSON.read_text(encoding="utf-8"))
        except ValueError:
            old = None
    unchanged = old is not None and old.get("features") == kept and old.get("directions") == directions
    if unchanged:
        print(f"No changes: still {len(kept)} areas across {len(directions)} directions.")
        fc["metadata"]["downloaded"] = old["metadata"]["downloaded"]
    else:
        OUT_GEOJSON.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
        print(f"Saved {len(kept)} areas across {len(directions)} directions to {OUT_GEOJSON.relative_to(ROOT)}")
        counts = {}
        for f in kept:
            ref = link_direction(f["properties"], directions)
            counts[ref] = counts.get(ref, 0) + 1
        for ref, d in sorted(directions.items()):
            n = counts.get(ref, 0)
            print(f"  {ref}: {d.get('name', '')} ({n} area{'' if n == 1 else 's'})")
        if counts.get(None):
            print(f"  Not linked to a direction: {counts[None]} area(s). Check their descriptions on planning.data.gov.uk.")

    write_bundle(fc)


def write_bundle(official):
    """Regenerate js/data.js so the page also works when opened from disk."""
    def read(name):
        return json.loads((DATA / name).read_text(encoding="utf-8"))

    bundle = {"boundary": read("kingston-boundary.geojson"), "offlineA4": official}
    legacy = DATA / "article4-legacy-2022.geojson"
    if legacy.exists():
        bundle["legacyA4"] = read(legacy.name)
    text = ("// Generated by scripts/update_offline_data.py (or scripts/build-data.mjs) "
            "from data/*.geojson. Do not edit by hand.\n"
            f"window.A4_DATA = {json.dumps(bundle, separators=(',', ':'))};\n")
    if OUT_JS.exists() and OUT_JS.read_text(encoding="utf-8") == text:
        return
    OUT_JS.write_text(text, encoding="utf-8")
    print(f"Updated {OUT_JS.relative_to(ROOT)} ({len(text) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
