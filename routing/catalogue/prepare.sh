#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/bendbound/routing
mkdir -p .data/map
if ! test -s .data/map/region.osm.pbf; then
  curl --fail --location --retry 5 -o .data/map/england.osm.pbf.part https://download.geofabrik.de/europe/united-kingdom/england-latest.osm.pbf
  mv .data/map/england.osm.pbf.part .data/map/england.osm.pbf
  python3 - <<'PY'
import math,json
lat,lon=51.5074,-0.1278
phi,lam=math.radians(lat),math.radians(lon); d=130000/6371000
pts=[]
for i in range(361):
 b=math.radians(i)
 p=math.asin(math.sin(phi)*math.cos(d)+math.cos(phi)*math.sin(d)*math.cos(b))
 l=lam+math.atan2(math.sin(b)*math.sin(d)*math.cos(phi),math.cos(d)-math.sin(phi)*math.sin(p))
 pts.append([math.degrees(l),math.degrees(p)])
with open('.data/map/area.geojson','w') as f:json.dump({'type':'FeatureCollection','features':[{'type':'Feature','properties':{},'geometry':{'type':'Polygon','coordinates':[pts]}}]},f)
PY
  osmium extract --polygon .data/map/area.geojson --strategy complete_ways --output-format pbf .data/map/england.osm.pbf -o .data/map/region.osm.pbf.part --overwrite
  mv .data/map/region.osm.pbf.part .data/map/region.osm.pbf
  python3 - <<'PY'
import hashlib,json,datetime
h=hashlib.sha256()
with open('.data/map/region.osm.pbf','rb') as f:
 for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
with open('.data/map/manifest.json','w') as f:json.dump({'source':'https://download.geofabrik.de/europe/united-kingdom/england-latest.osm.pbf','extractRadiusKm':130,'serviceRadiusKm':100,'center':{'latitude':51.5074,'longitude':-0.1278},'sha256':h.hexdigest(),'preparedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},f,indent=2)
PY
fi
compose() { bash catalogue/compose-aws.sh "$@"; }
compose up -d postgres neo4j
until compose exec -T postgres pg_isready -U bendbound -d roads >/dev/null; do sleep 5; done
python3 -m venv catalogue/.venv
catalogue/.venv/bin/pip install -r catalogue/requirements.txt
set -a
source catalogue/.env
set +a
export DATABASE_URL="postgresql://bendbound:${POSTGRES_PASSWORD}@127.0.0.1:5432/roads"
export NEO4J_URI=bolt://127.0.0.1:7687
for i in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:7474/ >/dev/null; then break; fi
  sleep 5
done
if ! test -s .data/map/road-network.osm.pbf; then
  osmium tags-filter .data/map/region.osm.pbf 'w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street,service' --output-format pbf -o .data/map/road-network.osm.pbf.part --overwrite
  mv .data/map/road-network.osm.pbf.part .data/map/road-network.osm.pbf
fi
export NEO4J_IMPORT_MODE=bulk
catalogue/.venv/bin/python catalogue/import.py .data/map/road-network.osm.pbf
map_version="$(python3 -c "import json; print(json.load(open('.data/map/manifest.json'))['sha256'])")"
if ! test -f catalogue/.imports/loaded-version || test "$(cat catalogue/.imports/loaded-version)" != "$map_version"; then
  compose stop neo4j
  docker run --rm --name bendbound-graph-import --memory 2g \
    -e NEO4J_server_memory_heap_initial__size=256m -e NEO4J_server_memory_heap_max__size=512m \
    -v "$PWD/.data/neo4j:/data" -v "$PWD/catalogue/.imports:/import:ro" \
    neo4j:5.26-community@sha256:c7d25c0eeebfe125718d58b72ed5d663c85d0479047733845eb2237c67ce8069 \
    neo4j-admin database import full neo4j --overwrite-destination=true --bad-tolerance=0 \
    --max-off-heap-memory=768M --threads=2 --id-type=string \
    --nodes=/import/junctions.csv --nodes=/import/sections.csv \
    --relationships=/import/roads.csv --relationships=/import/touches.csv
  printf '%s\n' "$map_version" > catalogue/.imports/loaded-version
  compose up -d neo4j
fi
catalogue/.venv/bin/python catalogue/graph_ready.py
compose up -d --build valhalla api
compose restart api # Clear caches when the prepared map/catalogue changes.
if test "${GRAPH_MODE:-on-demand}" = on-demand; then compose stop neo4j; fi
touch .data/catalogue-ready
