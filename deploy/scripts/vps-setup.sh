#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 LTS Hostinger VPS for PingDost staging (Phase 20,
# docs/ops/vps-setup.md). Run as root once:   sudo bash vps-setup.sh 'ssh-ed25519 AAAA… you@pc'
#
# - a `deploy` user (Docker group) that logs in with that SSH key only;
# - SSH: no passwords, no root login;
# - unattended security upgrades, a 2 GB swap file, Docker Engine + the Compose plugin
#   (Docker's apt repository);
# - /srv/pingdost with the scripts folder, and the cron jobs (monitor, nightly Mongo backup).
# The Hostinger panel firewall (22, 80, 443 only) is set in hPanel, not here: Docker's published
# ports bypass ufw.
set -euo pipefail

key=${1:?usage: vps-setup.sh '<your public SSH key>'}
[ "$(id -u)" = 0 ] || { echo 'run as root'; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl gnupg unattended-upgrades

# Unattended security upgrades (the Ubuntu default origins: security updates only).
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# Swap: 2 GB, used only under pressure.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
echo 'vm.swappiness=10' >/etc/sysctl.d/90-pingdost.conf
sysctl -q --system

# Docker Engine and the Compose plugin from Docker's repository.
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# The deploy user, SSH key only.
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos '' deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
grep -qxF "$key" /home/deploy/.ssh/authorized_keys 2>/dev/null || echo "$key" >>/home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

cat >/etc/ssh/sshd_config.d/90-pingdost.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
systemctl reload ssh

# The stack's folder; .env is created by hand (docs/ops/vps-setup.md).
install -d -m 750 -o deploy -g deploy /srv/pingdost /srv/pingdost/scripts /srv/pingdost/backups

cat >/etc/cron.d/pingdost <<'EOF'
# PingDost staging (Phase 20): thresholds every 5 minutes, the Atlas dump at 03:30 UTC.
*/5 * * * * deploy /srv/pingdost/scripts/monitor.sh >/dev/null 2>&1
30 3 * * * deploy /srv/pingdost/scripts/mongo-backup.sh >>/srv/pingdost/backups/backup.log 2>&1
EOF

echo 'Done. Keep this root session open and check in a second terminal: ssh deploy@<vps-ip>'
