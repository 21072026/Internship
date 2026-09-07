#!/usr/bin/env bash
#
# Point one hostname at N app replicas (#1701).
#
# The reverse proxy is the only piece of a two-replica environment that is not
# in the application: `infra/deploy-prod.sh` starts the containers, this script
# tells the proxy which of them are currently in the pool. It is called once as
# a PRE-FLIGHT (before any container is touched, so a box whose proxy this
# script cannot drive fails the deploy while everything is still serving), then
# again around each replica swap to drain it and put it back.
#
#   ./infra/server/replica-route.sh --host interncrm.com --ports "3200 3210"
#   ./infra/server/replica-route.sh --host interncrm.com --ports "3210" # drained
#   ./infra/server/replica-route.sh --host interncrm.com --ports "3200" # back to one
#
# The last form is the whole rollback story: a single port writes exactly the
# one-upstream file `infra/server/bootstrap.sh` writes, so an environment goes
# back to one replica by deploying with REPLICAS=1 — no hand-editing, nothing
# left behind. Re-running bootstrap's `sites` step does the same.
#
# NO STICKY SESSIONS, DELIBERATELY. Nothing in this app is pinned to a process:
# the session is a signed JWT (src/lib/auth.ts) so any replica can verify it
# without shared state, the rate-limit counters moved to a shared store in
# #1696, uploads go to the database, and the SSE stream reconnects by itself on
# a dropped connection (src/app/api/realtime/stream/route.ts). `ip_hash` would
# therefore buy nothing and cost the two things it always costs: one replica
# gets every request from a NATed office, and draining a replica strands its
# sessions instead of moving them. The generated config says so too, so the
# next person to read it does not add it "to be safe".
#
# ROUTER DETECTION mirrors infra/server/topic-deploy.sh — Caddy on the current
# host, Plesk/nginx on the retired one — and `ROUTER=` forces either.
#
# FLAGS
#   --host <fqdn>     the hostname to route (required)
#   --ports "<list>"  space-separated loopback ports, in pool order (required)
#   --tls auto|wildcard
#                     auto (default): no `tls` line — Caddy obtains and renews
#                     the certificate itself, which is what the apex and
#                     `preview.` already do. wildcard: pin the installed
#                     wildcard cert, for a name that cannot pass an ACME
#                     challenge (what topic environments use).
#
# ENV
#   CADDY_SITES_DIR   (default /etc/caddy/sites)
#   CADDY_RELOAD_CMD  (default "caddy validate … && systemctl reload caddy")
#   NGINX_CONF_DIR    (default /etc/nginx/conf.d)      — Plesk branch only
#   CERT_DIR          (default /etc/caddy/certs, else /etc/nginx/ssl)
#   ROUTER            force "caddy" or "plesk"
#
set -euo pipefail

HOST=""
PORTS=""
TLS_MODE="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --host)  HOST="${2:-}"; shift 2 ;;
    --ports) PORTS="${2:-}"; shift 2 ;;
    --tls)   TLS_MODE="${2:-auto}"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done
[ -n "$HOST" ]  || { echo "ERROR: --host is required" >&2; exit 2; }
[ -n "$PORTS" ] || { echo "ERROR: --ports is required" >&2; exit 2; }

CADDY_SITES_DIR="${CADDY_SITES_DIR:-/etc/caddy/sites}"
if [ -z "${CERT_DIR:-}" ]; then
  if [ -d /etc/caddy/certs ]; then CERT_DIR=/etc/caddy/certs; else CERT_DIR=/etc/nginx/ssl; fi
fi
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx/conf.d}"

# Same privilege dance as topic-deploy.sh: the deploy user owns neither
# /etc/caddy/sites nor the caddy service, so both need sudo when we are not
# already root. Kept as a variable so a root-owned bootstrap run needs none.
_SUDO=""
if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then _SUDO="sudo "; fi
_priv() { if [ -n "$_SUDO" ]; then sudo "$@"; else "$@"; fi; }
CADDY_RELOAD_CMD="${CADDY_RELOAD_CMD:-caddy validate --config /etc/caddy/Caddyfile && ${_SUDO}systemctl reload caddy}"

ROUTER="${ROUTER:-}"
if [ -z "$ROUTER" ]; then
  if command -v caddy >/dev/null 2>&1; then ROUTER=caddy
  elif command -v plesk >/dev/null 2>&1; then ROUTER=plesk
  else echo "ERROR: neither caddy nor plesk found on PATH" >&2; exit 1; fi
fi

# The pool, as upstream addresses. Loopback only: the containers run with
# --network=host and must never be reachable from outside the box.
UPSTREAMS=""
for port in $PORTS; do
  case "$port" in
    ''|*[!0-9]*) echo "ERROR: '$port' is not a port number" >&2; exit 2 ;;
  esac
  UPSTREAMS="${UPSTREAMS}127.0.0.1:${port} "
done
UPSTREAMS="${UPSTREAMS% }"
COUNT=$(printf '%s\n' $PORTS | wc -l | tr -d ' ')

route_caddy() {
  _priv mkdir -p "$CADDY_SITES_DIR"

  local tls_line=""
  if [ "$TLS_MODE" = wildcard ]; then
    local base="${HOST#*.}"
    if [ -f "${CERT_DIR}/${base}.cer" ] && [ -f "${CERT_DIR}/${base}.key" ]; then
      tls_line="    tls ${CERT_DIR}/${base}.cer ${CERT_DIR}/${base}.key"
    else
      echo "==> WARN: --tls wildcard but no cert at ${CERT_DIR}/${base}.cer — Caddy will issue per-host"
    fi
  fi

  local file="${CADDY_SITES_DIR}/${HOST}.caddy"
  # Keep the current file so a rejected config can be UNDONE rather than
  # deleted. topic-deploy.sh deletes on rejection, which is right for a topic
  # environment (its absence costs a PR preview) and wrong here: deleting
  # interncrm.com's site file would take production off the internet to avoid a
  # bad load-balancer stanza.
  local previous=""
  if [ -f "$file" ]; then
    previous="$(mktemp)"
    cat "$file" > "$previous"
  fi
  {
    echo "# Managed by infra/server/replica-route.sh (#1701) — do not edit by hand."
    echo "# ${COUNT} replica(s) in the pool. Add or remove one by deploying with"
    echo "# REPLICAS=<n>; this file is rewritten on every deploy."
    echo "#"
    echo "# No ip_hash / sticky sessions, on purpose: the session is a signed JWT,"
    echo "# the rate-limit counters are in a shared store (#1696) and the SSE stream"
    echo "# reconnects itself, so no request depends on reaching the same process."
    echo "# Pinning clients would only concentrate a NATed office on one replica and"
    echo "# strand its sessions whenever that replica is drained."
    echo "${HOST} {"
    if [ -n "$tls_line" ]; then echo "$tls_line"; fi
    if [ "$COUNT" = 1 ]; then
      # Byte-identical to what bootstrap.sh writes for a single-container
      # environment: one replica must not carry any of the machinery below.
      echo "    reverse_proxy ${UPSTREAMS}"
    else
      echo "    reverse_proxy ${UPSTREAMS} {"
      echo "        lb_policy round_robin"
      # A replica that dies mid-request must cost that request nothing: Caddy
      # retries it on the other one within this window, which is what makes
      # `kill -9` on one container invisible to a browser.
      echo "        lb_try_duration 5s"
      echo "        lb_try_interval 250ms"
      # Active checks, because the passive kind only notices a replica after it
      # has already failed somebody's request. /api/health without a query
      # string is the cheap liveness answer — no database, no queue counters.
      echo "        health_uri /api/health"
      echo "        health_interval 5s"
      echo "        health_timeout 2s"
      # Belt and braces for the case active checks cannot see (a replica that
      # accepts and then errors): take it out for 10s after a failure.
      echo "        fail_duration 10s"
      echo "    }"
    fi
    echo "}"
  } | _priv tee "$file" >/dev/null

  # Validate BEFORE reloading. Caddy loads one config for the whole box, so a
  # bad file here would take production, preview and every topic environment
  # down together (#2213).
  if ! eval "$CADDY_RELOAD_CMD"; then
    if [ -n "$previous" ]; then
      _priv cp "$previous" "$file"
      rm -f "$previous"
      echo "ERROR: caddy rejected the routing for ${HOST}; restored the previous site file" >&2
    else
      _priv rm -f "$file"
      echo "ERROR: caddy rejected the generated site file for ${HOST}; removed it" >&2
    fi
    eval "$CADDY_RELOAD_CMD" || true
    exit 1
  fi
  [ -n "$previous" ] && rm -f "$previous"
  echo "==> ${HOST} -> ${UPSTREAMS} (${COUNT} replica(s), caddy)"
}

route_plesk() {
  # The retired Plesk box owns 80/443 and every site is a panel-managed vhost.
  # Rewriting one from here is how you lose production to a panel resync, so
  # this branch REFUSES and prints the block to install instead. It is not a
  # gap in the script: the live host runs Caddy (#2166), and a deploy with
  # REPLICAS=1 — the default — never reaches this function at all.
  cat >&2 <<EOF
ERROR: multi-replica routing is not automated on the Plesk host.

Add this to ${NGINX_CONF_DIR}/internship-upstream.conf and point the vhost's
proxy_pass at it (Plesk → Apache & nginx Settings → Additional nginx
directives), then reload nginx:

    # No ip_hash / sticky sessions, on purpose: the session is a signed JWT,
    # the rate-limit counters are in a shared store (#1696) and the SSE stream
    # reconnects itself, so no request depends on reaching the same process.
    upstream internship_${HOST//[.-]/_} {
$(for u in $UPSTREAMS; do echo "        server ${u} max_fails=2 fail_timeout=10s;"; done)
    }
    # in the vhost:
    #   location / { proxy_pass http://internship_${HOST//[.-]/_}; }

Then re-run the deploy. Until that is in place, deploy with REPLICAS=1.
EOF
  exit 1
}

if [ "$ROUTER" = caddy ]; then route_caddy; else route_plesk; fi
