#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
extra=()
if test -f .data/graph/enabled; then extra=(-f catalogue/graph.compose.yml); fi
if test -f .data/uk-enabled; then
  test -f .data/graph/enabled || { echo 'UK graph mode requires the graph adapter.' >&2; exit 1; }
  test -s .data/uk-current/valhalla/tiles.tar && test -s .data/uk-current/graph/ratings.sqlite || { echo 'UK artifacts missing; preserve the current deployment.' >&2; exit 1; }
  extra+=(-f catalogue/uk.compose.yml)
fi
exec docker compose --env-file catalogue/.env -f catalogue/compose.yml -f catalogue/cloudwatch.compose.yml "${extra[@]}" "$@"
