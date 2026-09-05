#!/usr/bin/env bash
#
# One-command server bootstrap (#2166).
#
# WHY THIS EXISTS
#   This is the project's SECOND server. The first one (s.ersah.in, Plesk) was
#   configured by hand over months, and by the end nobody could answer "what is
#   actually running on this box" without logging in and looking. Every Plesk
#   quirk that infra/README.md documents — `plesk bin subdomain --create`, the
#   `listen <IP>:443` address-group match, hand-written vhosts in conf.d, the
#   acme.sh wildcard dance — exists because the panel owned 80/443 and we had to
#   work around it. There will be a third server. So the setup is a script in
#   the repo, not a memory: idempotent, re-runnable, and reviewable in a diff.
#
# WHAT IT SETS UP
#   Docker CE + compose/buildx · Caddy (owns 80/443, automatic Let's Encrypt) ·
#   MySQL 8.0 in a container bound to 127.0.0.1 · firewall · fail2ban · swap ·
#   journald caps · Tailscale (installed, not logged in) · a few QoL tools.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   - No Plesk/cPanel. Dropping the panel is the entire point of the migration.
#   - No `tailscale up` — that needs an interactive browser login.
#   - No GitHub Actions runner registration — that needs a short-lived token.
#   - No DNS and no Oracle VCN security-list changes — those live outside the box
#     (see docs/server-migration.md for the human steps).
#
# USAGE
#   scp infra/server/bootstrap.sh ubuntu@<host>:/tmp/ && \
#     ssh ubuntu@<host> 'sudo ACME_EMAIL=you@example.com bash /tmp/bootstrap.sh'
#
#   Flags:
#     --only  <a,b>   run just these steps
#     --skip  <a,b>   run everything except these
#     --list          print the step names and exit
#
#   Env:
#     ACME_EMAIL   address Let's Encrypt uses for expiry warnings (optional)
#     APP_DIR      default /opt/internship-crm
#     SWAP_GB      default 4
#     MYSQL_IMAGE  default mysql:8.0 — MUST match the CI service image, see below
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/internship-crm}"
SWAP_GB="${SWAP_GB:-4}"
# CI (e2e.yml, e2e-full.yml) runs `mysql:8.0`. The previous server ran MariaDB,
# and that mismatch cost us a production incident: a new non-nullable `Json`
# column backfilled as '' on MariaDB and locked every existing user out, while
# CI stayed green on MySQL 8. Same engine everywhere, or the tests are lying.
MYSQL_IMAGE="${MYSQL_IMAGE:-mysql:8.0}"
ACME_EMAIL="${ACME_EMAIL:-}"

STEPS=(preflight packages swap journald firewall docker fail2ban caddy mysql tools harden summary)
ONLY=""
SKIP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:?--only needs a value}"; shift 2 ;;
    --skip) SKIP="${2:?--skip needs a value}"; shift 2 ;;
    --list) printf '%s\n' "${STEPS[@]}"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[0;32m✓\033[0m %s\n' "$*"; }
skip() { printf '    \033[0;90m·\033[0m %s\n' "$*"; }
warn() { printf '    \033[0;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run me as root (sudo bash $0)"

# The login user, so docker group membership and file ownership land on a human
# rather than on root. SUDO_USER is set when invoked through sudo.
LOGIN_USER="${SUDO_USER:-ubuntu}"

# ---------------------------------------------------------------- preflight --
step_preflight() {
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || die "expected Ubuntu, found ${ID:-unknown}"
  ok "Ubuntu ${VERSION_ID} (${VERSION_CODENAME}) on $(dpkg --print-architecture)"

  # arm64 is not a detail. The images this project ships are built on
  # ubuntu-latest, i.e. amd64; pulling one here fails at `docker run` with
  # "exec format error", not at pull time. build-image.yml has to emit a
  # multi-arch manifest before any deploy to this host can work.
  if [ "$(dpkg --print-architecture)" = "arm64" ]; then
    warn "arm64 host — app images must be built for linux/arm64 (see #2166)"
  fi

  id "$LOGIN_USER" >/dev/null 2>&1 || die "login user '$LOGIN_USER' does not exist"
  ok "login user: $LOGIN_USER"
}

# ----------------------------------------------------------------- packages --
step_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # ca-certificates/curl/gnupg are needed to add the Docker and Caddy repos;
  # the rest is the "can I debug this box at 2am" set.
  apt-get install -y -qq --no-install-recommends \
    ca-certificates curl gnupg git jq unzip zip \
    btop ncdu tmux ripgrep tree rsync \
    debian-keyring debian-archive-keyring apt-transport-https \
    mysql-client
  ok "base packages installed"
}

# --------------------------------------------------------------------- swap --
step_swap() {
  # 23 GB of RAM is plenty for the app, but `next build` inside a container
  # alongside MySQL and a few topic environments is exactly the shape of
  # workload that finds the OOM killer. Swap is the cheap insurance.
  if [ "$(swapon --show --noheadings | wc -l)" -gt 0 ]; then
    skip "swap already active: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
    return
  fi
  fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB * 1024))
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer RAM; swap is a safety net, not a tier of memory.
  sysctl -qw vm.swappiness=10
  printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-swappiness.conf
  ok "${SWAP_GB}G swapfile active, swappiness=10"
}

# ----------------------------------------------------------------- journald --
step_journald() {
  # 193 GB free today. Unbounded journals plus container logs is still the most
  # common way a box like this fills its disk six months later.
  install -d /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/99-size.conf <<'EOF'
[Journal]
SystemMaxUse=500M
SystemMaxFileSize=50M
MaxRetentionSec=1month
EOF
  systemctl restart systemd-journald
  ok "journald capped at 500M / 1 month"
}

# ------------------------------------------------------------------- docker --
step_docker() {
  if ! command -v docker >/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    . /etc/os-release
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get update -qq
    # docker.io from Ubuntu universe would also work, but it ships neither the
    # compose v2 plugin nor buildx, and buildx is what will cross-build arm64.
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin
  fi

  # Container logs default to unbounded json-file. Same disk story as journald.
  install -d /etc/docker
  if [ ! -f /etc/docker/daemon.json ]; then
    cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" },
  "live-restore": true
}
EOF
    systemctl restart docker
  fi

  usermod -aG docker "$LOGIN_USER"
  systemctl enable --now docker >/dev/null
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,) + compose $(docker compose version --short)"
  warn "$LOGIN_USER must re-login for the docker group to take effect"
}

# ----------------------------------------------------------------- firewall --
step_firewall() {
  # DELIBERATELY NOT ufw. Two reasons, both specific to this host:
  #
  #  1. Oracle's cloud image already owns the filter table through
  #     /etc/iptables/rules.v4 + netfilter-persistent, and its OUTPUT
  #     `InstanceServices` chain is not decoration — it gates iSCSI (port 3260,
  #     how the boot volume is attached on some shapes), the metadata service
  #     and NTP. ufw would be a second owner of the same table, and
  #     netfilter-persistent's `iptables-restore` FLUSHES it on boot: whichever
  #     unit starts last silently wins.
  #  2. Docker publishes ports by writing into the nat/DOCKER chains, which ufw
  #     does not see. A ufw rule denying 3306 would not stop
  #     `-p 3306:3306` from being reachable from the internet anyway.
  #
  # So: extend the file Oracle already uses, and bind every container to
  # 127.0.0.1 so Docker cannot publish past the firewall in the first place.
  local rules=/etc/iptables/rules.v4
  [ -f "$rules" ] || die "$rules missing — is this an Oracle cloud image?"

  [ -f "${rules}.pre-bootstrap" ] || cp -a "$rules" "${rules}.pre-bootstrap"

  local changed=0
  for port in 80 443; do
    if grep -qE -- "^-A INPUT .*--dport ${port} -j ACCEPT" "$rules"; then
      skip "port ${port} already allowed"
    else
      # Insert before the catch-all REJECT, never after it.
      sed -i "/-A INPUT -j REJECT/i -A INPUT -p tcp -m state --state NEW -m tcp --dport ${port} -j ACCEPT" "$rules"
      changed=1
      ok "port ${port} allowed"
    fi
  done

  # Docker needs to forward between its bridge and the host. Oracle's blanket
  # `-A FORWARD -j REJECT` sits in the chain Docker also writes to; Docker
  # inserts its own rules at the head so containers work today, but the REJECT
  # is a trap for anyone who later reloads the rules in a different order.
  if grep -q -- '-A FORWARD -j REJECT' "$rules"; then
    sed -i '/-A FORWARD -j REJECT/d' "$rules"
    changed=1
    ok "removed blanket FORWARD REJECT (Docker manages FORWARD)"
  fi

  if [ "$changed" -eq 1 ]; then
    # iptables-restore FLUSHES every chain in the tables the file declares, and
    # rules.v4 declares *filter — which is where Docker keeps DOCKER,
    # DOCKER-USER and DOCKER-ISOLATION-STAGE-*. Restoring therefore silently
    # cuts container networking until dockerd rebuilds them. This step runs
    # before `docker` for that reason; the restart covers a re-run on a host
    # where Docker is already up.
    iptables-restore < "$rules"
    ok "rules reloaded and persisted"
    if systemctl is-active --quiet docker; then
      systemctl restart docker
      ok "restarted docker so it re-creates its filter chains"
    fi
  fi

  systemctl enable netfilter-persistent >/dev/null 2>&1 || true
  warn "Oracle VCN security list / NSG must ALSO allow 80+443 — that is outside this box"
}

# ----------------------------------------------------------------- fail2ban --
step_fail2ban() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
  # Ubuntu 26.04 has no /var/log/auth.log by default; sshd logs to the journal.
  cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
EOF
  systemctl enable --now fail2ban >/dev/null
  systemctl restart fail2ban
  ok "fail2ban active (sshd jail, systemd backend)"
}

# -------------------------------------------------------------------- caddy --
step_caddy() {
  if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -qq
    apt-get install -y -qq caddy
  fi

  # One include directory, one file per site. topic-deploy.sh will drop
  # crm-pr<N>.caddy in here and reload — which replaces ~200 lines of Plesk
  # subdomain creation + nginx vhost generation with a two-line file.
  install -d -o root -g caddy -m 0775 /etc/caddy/sites

  if [ ! -f /etc/caddy/Caddyfile.pre-bootstrap ] && [ -f /etc/caddy/Caddyfile ]; then
    cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-bootstrap
  fi

  {
    echo "# Managed by infra/server/bootstrap.sh (#2166) — site files live in /etc/caddy/sites/"
    echo "{"
    [ -n "$ACME_EMAIL" ] && echo "    email ${ACME_EMAIL}"
    echo "}"
    echo
    echo "import /etc/caddy/sites/*.caddy"
  } > /etc/caddy/Caddyfile

  # `import` fails on a glob that matches no files, so the directory is never
  # allowed to be empty. This placeholder is also the box's own health check.
  #
  # Deliberately NOT a bare `:80` catch-all: such a block competes with the
  # automatic HTTP->HTTPS redirect routes and the ACME HTTP-01 challenge routes
  # that every named site depends on. Caddy already answers 404 for a Host it
  # has no site for — which was the whole point (on the old box an unmatched
  # host fell through to Plesk's default vhost and served login_up.php).
  #
  # `localhost` gets Caddy's internal self-signed CA, never a public ACME order.
  cat > /etc/caddy/sites/00-localhost.caddy <<'EOF'
localhost {
    respond "internship-crm: caddy is up" 200
}
EOF

  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    || die "generated Caddyfile does not validate"
  systemctl enable --now caddy >/dev/null
  systemctl reload caddy || systemctl restart caddy
  ok "caddy $(caddy version | head -1 | awk '{print $1}') serving, sites dir /etc/caddy/sites"
  [ -n "$ACME_EMAIL" ] || warn "ACME_EMAIL unset — Let's Encrypt cannot mail expiry warnings"
}

# -------------------------------------------------------------------- mysql --
step_mysql() {
  install -d -m 0755 "$APP_DIR"
  install -d -m 0700 "$APP_DIR/secrets"
  install -d -m 0755 "$APP_DIR/mysql"

  local envfile="$APP_DIR/secrets/mysql.env"
  if [ ! -f "$envfile" ]; then
    # Generated here and never printed. The DATABASE_URL the deploy needs is
    # assembled from this file; copy it into the GitHub secret from the server,
    # not through a chat window.
    umask 077
    cat > "$envfile" <<EOF
MYSQL_ROOT_PASSWORD=$(openssl rand -base64 33 | tr -d '/+=' | head -c 32)
APP_DB_PASSWORD=$(openssl rand -base64 33 | tr -d '/+=' | head -c 32)
EOF
    chmod 600 "$envfile"
    ok "generated $envfile (0600)"
  else
    skip "$envfile already exists — keeping the existing passwords"
  fi
  # shellcheck disable=SC1090
  set -a; . "$envfile"; set +a

  cat > "$APP_DIR/mysql/compose.yml" <<EOF
# Managed by infra/server/bootstrap.sh (#2166).
#
# Pinned to the image CI uses (${MYSQL_IMAGE}) — see the MYSQL_IMAGE comment in
# bootstrap.sh for why "whatever the distro ships" is not an option here.
#
# 127.0.0.1 in the port binding is load-bearing: Docker publishes ports by
# writing nat rules the host firewall never sees, so "0.0.0.0:3306" would put
# this database on the public internet regardless of iptables.
services:
  mysql:
    image: ${MYSQL_IMAGE}
    container_name: internship-mysql
    restart: unless-stopped
    ports:
      - "127.0.0.1:3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:?}
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
      # The app stores CVs and mentor notes; 64M covers a fat interaction log
      # import without turning into a packet-size incident mid-restore.
      - --max_allowed_packet=64M
    volumes:
      - mysql-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-p\${MYSQL_ROOT_PASSWORD}"]
      interval: 10s
      timeout: 5s
      retries: 12

volumes:
  mysql-data:
EOF

  ln -sfn "$envfile" "$APP_DIR/mysql/.env"
  docker compose -f "$APP_DIR/mysql/compose.yml" up -d

  # Wait for the server to accept connections before granting anything.
  local i
  for i in $(seq 1 60); do
    if docker exec internship-mysql mysqladmin ping -h 127.0.0.1 \
         -p"$MYSQL_ROOT_PASSWORD" --silent >/dev/null 2>&1; then break; fi
    [ "$i" -eq 60 ] && die "mysql did not become healthy in 60s"
    sleep 1
  done

  # The app user needs CREATE/DROP across `internship_%` because every PR gets
  # its own database (#1185); granting only on `internship` would send
  # topic-deploy.sh down its root-socket fallback path on every deploy.
  docker exec -i internship-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<EOF
CREATE DATABASE IF NOT EXISTS internship
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'internship'@'%' IDENTIFIED BY '${APP_DB_PASSWORD}';
ALTER USER 'internship'@'%' IDENTIFIED BY '${APP_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`internship\`.* TO 'internship'@'%';
GRANT ALL PRIVILEGES ON \`internship\_%\`.* TO 'internship'@'%';
FLUSH PRIVILEGES;
EOF
  ok "mysql up (127.0.0.1:3306), database 'internship', user 'internship'"
}

# -------------------------------------------------------------------- tools --
step_tools() {
  # Tailscale: installed but NOT logged in — `tailscale up` opens a browser
  # auth URL, which cannot be done from a script. Once it is up, SSH and MySQL
  # can leave the public internet entirely (the old box carried an open-3306
  # finding for months precisely because there was no private path).
  if ! command -v tailscale >/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1 \
      && ok "tailscale installed (run 'sudo tailscale up' to join a tailnet)" \
      || warn "tailscale install failed — not fatal, install by hand later"
  else
    skip "tailscale already installed"
  fi

  # lazydocker: container logs/stats without a web panel to secure.
  if ! command -v lazydocker >/dev/null; then
    local lzd_ver lzd_arch tmp
    lzd_ver="$(curl -fsSL https://api.github.com/repos/jesseduffield/lazydocker/releases/latest | jq -r .tag_name | tr -d v)"
    case "$(dpkg --print-architecture)" in
      arm64) lzd_arch=arm64 ;;
      amd64) lzd_arch=x86_64 ;;
      *) lzd_arch="" ;;
    esac
    if [ -n "$lzd_ver" ] && [ -n "$lzd_arch" ]; then
      tmp="$(mktemp -d)"
      curl -fsSL "https://github.com/jesseduffield/lazydocker/releases/download/v${lzd_ver}/lazydocker_${lzd_ver}_Linux_${lzd_arch}.tar.gz" \
        | tar -xz -C "$tmp" lazydocker 2>/dev/null \
        && install -m 0755 "$tmp/lazydocker" /usr/local/bin/lazydocker \
        && ok "lazydocker ${lzd_ver}" || warn "lazydocker download failed (skipped)"
      rm -rf "$tmp"
    fi
  else
    skip "lazydocker already installed"
  fi

  # GitHub CLI — the deploy pipeline is driven from GitHub; being able to read
  # run logs from the box itself has paid for the 30 MB more than once.
  if ! command -v gh >/dev/null; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list
    apt-get update -qq && apt-get install -y -qq gh
    ok "gh $(gh --version | head -1 | awk '{print $3}')"
  else
    skip "gh already installed"
  fi
}

# ------------------------------------------------------------------- harden --
step_harden() {
  # sshd on the Oracle image already has PasswordAuthentication no and
  # PermitRootLogin prohibit-password. Verify rather than assume — a future
  # image, or a stray sshd_config.d drop-in, could change either.
  local pw rl
  pw="$(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
  rl="$(sshd -T 2>/dev/null | awk '/^permitrootlogin/{print $2}')"
  if [ "$pw" = "no" ]; then ok "sshd: password auth disabled"
  else warn "sshd: passwordauthentication=$pw — should be no"; fi
  if [ "$rl" = "prohibit-password" ] || [ "$rl" = "no" ]; then ok "sshd: root login $rl"
  else warn "sshd: permitrootlogin=$rl"; fi

  # `opc` is a leftover of the Oracle base image (uid 1000, /bin/sh, no known
  # owner). An unused account with a shell is a login surface for nothing.
  if id opc >/dev/null 2>&1; then
    if [ "$(passwd -S opc 2>/dev/null | awk '{print $2}')" = "L" ]; then
      skip "opc already locked"
    else
      usermod -L -s /usr/sbin/nologin opc
      ok "locked unused 'opc' account (Oracle image leftover)"
    fi
  fi

  # Unattended upgrades is already running; make sure security updates actually
  # get applied rather than just downloaded.
  install -d /etc/apt/apt.conf.d
  cat > /etc/apt/apt.conf.d/51-internship-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
  ok "unattended-upgrades: auto-reboot off, old kernels pruned"
}

# ------------------------------------------------------------------ summary --
step_summary() {
  cat <<EOF

  ────────────────────────────────────────────────────────────────
   Bootstrap complete — $(hostname)
  ────────────────────────────────────────────────────────────────
   docker       $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)
   compose      $(docker compose version --short 2>/dev/null)
   caddy        $(caddy version 2>/dev/null | head -1 | awk '{print $1}')
   mysql        $(docker exec internship-mysql mysql --version 2>/dev/null | awk '{print $3}')
   swap         $(swapon --show=SIZE --noheadings | tr '\n' ' ')
   fail2ban     $(systemctl is-active fail2ban)
   tailscale    $(tailscale status --json 2>/dev/null | jq -r '.BackendState' 2>/dev/null || echo "not logged in")

   Secrets      $APP_DIR/secrets/mysql.env   (0600, never leaves the box)
   Caddy sites  /etc/caddy/sites/*.caddy
   Firewall     /etc/iptables/rules.v4  (backup: .pre-bootstrap)

   STILL REQUIRED, and not doable from here:
     1. Oracle VCN security list / NSG: open 80 + 443 ingress
     2. DNS: point the CRM hostnames at this box, proxy OFF (grey cloud)
     3. sudo tailscale up
     4. Register the GitHub Actions self-hosted runner
     5. Build app images for linux/arm64 — amd64 images will NOT run here
  ────────────────────────────────────────────────────────────────

EOF
}

# --------------------------------------------------------------------- main --
should_run() {
  local s="$1"
  [ -n "$ONLY" ] && { [[ ",$ONLY," == *",$s,"* ]] && return 0 || return 1; }
  [ -n "$SKIP" ] && [[ ",$SKIP," == *",$s,"* ]] && return 1
  return 0
}

for s in "${STEPS[@]}"; do
  should_run "$s" || continue
  log "$s"
  "step_$s"
done
