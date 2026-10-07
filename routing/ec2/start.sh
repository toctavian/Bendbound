#!/usr/bin/env bash
set -euo pipefail
test -f /opt/bendbound/host-ready
cd /opt/bendbound
docker run --rm -v "$PWD/routing:/work" -w /work \
  node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 \
  node prepare.mjs
docker compose -f routing/compose.yml -f routing/compose.small.yml up -d valhalla api
curl --fail --silent --show-error --max-time 10 \
  --retry 12 --retry-delay 5 --retry-all-errors http://127.0.0.1:8088/health
