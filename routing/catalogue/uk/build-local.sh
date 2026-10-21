#!/usr/bin/env bash
# CPU-heavy preparation runs on the Mac; only finished artifacts go to EC2.
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
stage="$PWD/.data/uk-20261020"
mkdir -p "$stage/map" "$stage/valhalla"
image=ghcr.io/valhalla/valhalla:3.9.0@sha256:511c095b8caf393dccceb8b519ec96b6f85a0166b2288ba014a8a748acc5a63c
if ! test -f "$stage/map/region.osm.pbf"; then
 test -s "$stage/map/region.osm.pbf.part"
 curl --fail --location --silent --show-error https://download.geofabrik.de/europe/united-kingdom-261018.osm.pbf.md5 -o "$stage/map/source.md5"
 expected=$(awk '{print $1}' "$stage/map/source.md5")
 actual=$(md5 -q "$stage/map/region.osm.pbf.part")
 test "$expected" = "$actual"
 mv "$stage/map/region.osm.pbf.part" "$stage/map/region.osm.pbf"
fi
# Reuse the deterministic in-container build steps, without EC2 swap/launch code.
python3 - "$stage" <<'PY'
from pathlib import Path
import sys
stage=Path(sys.argv[1]);script=Path('catalogue/uk/build-graph.sh').read_text().split("<<'INNER'\n",1)[1].split('\nINNER',1)[0]
(stage/'build-inside.sh').write_text(script)
PY
docker run --rm --name bendbound-uk-local-build --cpus 2 --memory 5g --memory-swap 6g \
 -v "$stage/map:/input:ro" -v "$stage/valhalla:/data" \
 -v "$stage/build-inside.sh:/uk-build.sh:ro" --entrypoint bash "$image" /uk-build.sh
# Marker signifies graph/way-index preparation, not deployment acceptance.
touch "$stage/GRAPH_READY"
