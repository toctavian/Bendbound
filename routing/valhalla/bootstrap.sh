#!/usr/bin/env bash
set -euo pipefail
test -s /input/region.osm.pbf || { echo 'Download routing data first (npm run routing:prepare).'; exit 1; }
mkdir -p /data/tiles
fingerprint="$(sha256sum /input/region.osm.pbf | cut -d ' ' -f 1)"
if test -f /data/map.sha256 && test "$(cat /data/map.sha256)" != "$fingerprint"; then
  echo 'The OSM extract changed. Use a fresh graph directory to rebuild; existing data was preserved.'
  exit 1
fi
valhalla_build_config --mjolnir-tile-dir /data/tiles --mjolnir-tile-extract /data/tiles.tar --mjolnir-admin /data/admin.sqlite > /data/valhalla.json
python3 - <<'PY'
import json
p='/data/valhalla.json'
with open(p) as f: config=json.load(f)
config['service_limits']['allow_hard_exclusions']=True
config['service_limits']['max_exclude_locations']=100
config['service_limits']['motorcycle']['max_locations']=50
config['service_limits']['motorcycle']['max_distance']=1000000
with open(p,'w') as f: json.dump(config,f)
PY
if ! test -f /data/map.sha256; then
  valhalla_build_admins -c /data/valhalla.json /input/region.osm.pbf
  valhalla_build_tiles -c /data/valhalla.json -j 2 /input/region.osm.pbf
  valhalla_build_extract -c /data/valhalla.json
  printf '%s\n' "$fingerprint" > /data/map.sha256
fi
exec valhalla_service /data/valhalla.json 2
