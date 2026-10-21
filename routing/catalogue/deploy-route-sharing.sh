#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../.data/route-shares
chown 1000:1000 ../.data/route-shares
chmod 700 ../.data/route-shares
# Base compose uses this copy; the EC2 overlay mounts catalogue/Caddyfile.
cat Caddyfile > ../Caddyfile
# The deployer must back up/upload the changed files before invoking this script.
docker cp Caddyfile "$(./compose-aws.sh ps -q caddy):/tmp/route-sharing.Caddyfile"
./compose-aws.sh exec -T caddy caddy validate --config /tmp/route-sharing.Caddyfile --adapter caddyfile
./compose-aws.sh build api
./compose-aws.sh up -d --no-deps api
# Uploaded archives can replace a bind-mounted inode. Recreate to mount the new
# file, preserving the certificate/config directories.
./compose-aws.sh up -d --no-deps --force-recreate caddy
