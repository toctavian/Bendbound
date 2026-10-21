#!/usr/bin/env bash
# Staging only: never replaces the active graph or changes EC2/EBS allocation.
set -Eeuo pipefail
stage=${1:?Staging directory required}
mkdir -p "$stage/map" "$stage/valhalla"
exec > >(tee -a "$stage/build.log") 2>&1
trap 'echo "UK_BUILD_FAILED line=$LINENO"; touch "$stage/FAILED"' ERR
image=ghcr.io/valhalla/valhalla:3.9.0@sha256:511c095b8caf393dccceb8b519ec96b6f85a0166b2288ba014a8a748acc5a63c
source=https://download.geofabrik.de/europe/united-kingdom-261018.osm.pbf
# Leave working service, data and rollback assets intact. Reserve disk headroom.
test "$(df --output=avail -k "$stage" | tail -1)" -gt 30000000
if ! test -s "$stage/map/region.osm.pbf"; then
  curl --fail --location --retry 5 "$source.md5" -o "$stage/map/source.md5"
  curl --fail --location --retry 5 "$source" -o "$stage/map/region.osm.pbf.part"
  expected=$(awk '{print $1}' "$stage/map/source.md5")
  actual=$(md5sum "$stage/map/region.osm.pbf.part" | cut -d ' ' -f 1)
  test "$expected" = "$actual"
  mv "$stage/map/region.osm.pbf.part" "$stage/map/region.osm.pbf"
fi
sha256sum "$stage/map/region.osm.pbf" > "$stage/map/source.sha256"
# Scratch swap uses only the existing root volume. It can be retired after import.
if ! swapon --show=NAME --noheadings | grep -qx /uk-build.swap; then
  if ! test -f /uk-build.swap; then
    fallocate -l 8G /uk-build.swap
    chmod 600 /uk-build.swap
    mkswap /uk-build.swap
  fi
  swapon /uk-build.swap
fi
cat > "$stage/build-inside.sh" <<'INNER'
set -Eeuo pipefail
valhalla_build_config --mjolnir-tile-dir /data/tiles --mjolnir-tile-extract /data/tiles.tar --mjolnir-admin /data/admin.sqlite > /data/valhalla.json
python3 - <<'PY'
import json
p='/data/valhalla.json';c=json.load(open(p))
c['mjolnir']['max_cache_size']=512*1024*1024
c['mjolnir']['use_lru_mem_cache']=True
c['mjolnir']['lru_mem_cache_hard_control']=True
c['thor']['min_linear_cost_factor']=0.75
c['service_limits']['allow_hard_exclusions']=True
c['service_limits']['max_exclude_locations']=100
c['service_limits']['motorcycle']['max_locations']=50
c['service_limits']['motorcycle']['max_distance']=2000000
json.dump(c,open(p,'w'))
PY
if ! test -f /data/build.complete; then
 if test -f /data/parsed.complete; then
  # Enhancement can alter tiles in place. Rebuild every tile from the complete
  # parsing checkpoint rather than reusing tiles from an interrupted enhancer.
  for level in 0 1 2 3; do rm -rf "/data/tiles/$level"; done
  valhalla_build_tiles -c /data/valhalla.json -j 1 --start build --end build
 else
  valhalla_build_admins -c /data/valhalla.json /input/region.osm.pbf
  valhalla_build_tiles -c /data/valhalla.json -j 1 --end build /input/region.osm.pbf
  touch /data/parsed.complete
 fi
 # Separate processes release all parsing data before enhancement/hierarchy.
 valhalla_build_tiles -c /data/valhalla.json -j 1 --start enhance
 valhalla_build_extract -c /data/valhalla.json
 touch /data/build.complete
fi
sha256sum /input/region.osm.pbf | cut -d ' ' -f 1 > /data/map.sha256
valhalla_ways_to_edges -c /data/valhalla.json
INNER
# CPU/I/O priority protects the existing London pilot during offline import.
nice -n 19 ionice -c 3 docker run --rm --name bendbound-uk-graph-build \
  --cpus 1 --memory 2300m --memory-swap 8g \
  -v "$stage/map:/input:ro" -v "$stage/valhalla:/data" \
  -v "$stage/build-inside.sh:/uk-build.sh:ro" \
  --entrypoint bash "$image" /uk-build.sh
touch "$stage/GRAPH_READY"
echo UK_GRAPH_READY
