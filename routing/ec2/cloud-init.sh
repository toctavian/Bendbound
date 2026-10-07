#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2
mkdir -p /etc/docker /opt/bendbound/routing
cat > /etc/docker/daemon.json <<'JSON'
{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}
JSON
systemctl enable --now docker
systemctl restart docker
if ! test -f /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-routing.conf
sysctl --system
if ! snap list amazon-ssm-agent >/dev/null 2>&1; then
  snap install amazon-ssm-agent --classic
fi
snap start amazon-ssm-agent
touch /opt/bendbound/host-ready
