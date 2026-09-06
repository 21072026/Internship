#!/usr/bin/env bash
#
# Create/update this project's public DNS records via the Cloudflare API
# (#636 / #583, extended for the server migration #2166).
#
# WHY A SCRIPT: the records have to agree with two things that are easy to get
# wrong by clicking — the server IP, and whether Cloudflare proxies the name.
#
# PROXIED DEFAULTS TO FALSE, AND THAT IS LOAD-BEARING.
#   `src/lib/rateLimit.ts` counts back from the right of X-Forwarded-For by
#   TRUSTED_PROXY_COUNT hops, which is 1 in every environment. Cloudflare's
#   proxy adds a second hop, so an orange-clouded hostname makes the limiter
#   bucket every visitor as the Cloudflare edge — one person's traffic then
#   throttles everybody. Turning the proxy on for a CRM hostname is therefore
#   not a free toggle: it has to happen in the same change as bumping
#   TRUSTED_PROXY_COUNT to 2 for that host. See infra/README.md.
#   (The old ersah.in wildcard was created proxied, before that was understood.)
#
# USAGE
#   export CF_Token="<scoped token: Zone:DNS:Edit + Zone:Read, this zone only>"
#   ./infra/setup-dns-cloudflare.sh            # DOMAIN/RECORDS/SERVER_IP overridable
#   # SERVER_IP is auto-detected when run ON the server.
#
#   Env:
#     DOMAIN      default interncrm.com
#     RECORDS     space-separated names, default "* www"  ('@' = apex)
#     SERVER_IP   default: this host's public IP
#     PROXIED     default false — read the note above before setting true
#
# Idempotent: an existing record with the right content and proxy setting is
# left alone; a wrong one is UPDATED rather than duplicated (Cloudflare happily
# holds two A records for one name and then answers with both).
#
# The wildcard TLS cert is a separate step — infra/acme-issue-wildcard.sh, run
# ON the server. DNS alone gets you a name that resolves and cannot do HTTPS.
set -euo pipefail
# DISABLE GLOBBING. RECORDS is iterated unquoted so it can hold several names,
# and the most important name in it is `*`. Without this, the shell expands that
# `*` against the working directory: a run in a repo checkout created A records
# called README.md.<domain>, src.<domain>, Dockerfile.<domain> … 27 of them, and
# silently never created the wildcard the caller actually asked for.
set -f

DOMAIN="${DOMAIN:-interncrm.com}"
RECORDS="${RECORDS:-* www}"
# Names to REMOVE. Exact names only — no patterns, so a typo cannot take out
# more than it names. Runs before the create/update pass.
DELETE_RECORDS="${DELETE_RECORDS:-}"
PROXIED="${PROXIED:-false}"
: "${CF_Token:?export CF_Token with a scoped Cloudflare API token first}"

SERVER_IP="${SERVER_IP:-}"
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
fi
[ -n "$SERVER_IP" ] || { echo "ERROR: set SERVER_IP=<public ip>" >&2; exit 1; }

case "$PROXIED" in true|false) ;; *) echo "ERROR: PROXIED must be true or false" >&2; exit 1 ;; esac

echo "==> Zone ${DOMAIN}, target ${SERVER_IP}, proxied=${PROXIED}"

api() { curl -sS -H "Authorization: Bearer $CF_Token" -H "Content-Type: application/json" "$@"; }

ZONE_ID="$(api "https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}" \
  | python3 -c "import sys,json;r=json.load(sys.stdin);print(r['result'][0]['id'] if r.get('result') else '')")"
[ -n "$ZONE_ID" ] || { echo "ERROR: zone ${DOMAIN} not visible to this token (needs Zone:Read on ${DOMAIN})" >&2; exit 1; }

# Look up an A record by name; prints "<id> <content> <proxied>" or "- - -".
lookup() {
  local q
  q="$(printf '%s' "$1" | sed 's/\*/%2A/')"
  api "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${q}" \
    | python3 -c "
import sys,json
r=json.load(sys.stdin).get('result') or []
print(r[0]['id'], r[0]['content'], str(r[0]['proxied']).lower()) if r else print('- - -')
"
}

for name in $DELETE_RECORDS; do
  if [ "$name" = "@" ]; then fqdn="$DOMAIN"; else fqdn="${name}.${DOMAIN}"; fi
  read -r del_id _ _ <<EOF
$(lookup "$fqdn")
EOF
  if [ "$del_id" = "-" ]; then
    echo "    absent   ${fqdn}"
  else
    api -X DELETE "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${del_id}" \
      | python3 -c "import sys,json;r=json.load(sys.stdin);assert r.get('success'),r" \
      && echo "    deleted  ${fqdn}"
  fi
done

for name in $RECORDS; do
  if [ "$name" = "@" ]; then fqdn="$DOMAIN"; else fqdn="${name}.${DOMAIN}"; fi

  read -r rec_id rec_ip rec_proxied <<EOF
$(lookup "$fqdn")
EOF

  if [ "$rec_id" = "-" ]; then
    api -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
      --data "{\"type\":\"A\",\"name\":\"${name}\",\"content\":\"${SERVER_IP}\",\"proxied\":${PROXIED},\"ttl\":1}" \
      | python3 -c "import sys,json;r=json.load(sys.stdin);assert r.get('success'),r" \
      && echo "    created  ${fqdn} → ${SERVER_IP} (proxied=${PROXIED})"
  elif [ "$rec_ip" = "$SERVER_IP" ] && [ "$rec_proxied" = "$PROXIED" ]; then
    echo "    ok       ${fqdn} → ${SERVER_IP} (proxied=${PROXIED})"
  else
    api -X PATCH "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${rec_id}" \
      --data "{\"content\":\"${SERVER_IP}\",\"proxied\":${PROXIED},\"ttl\":1}" \
      | python3 -c "import sys,json;r=json.load(sys.stdin);assert r.get('success'),r" \
      && echo "    updated  ${fqdn}: ${rec_ip}/proxied=${rec_proxied} → ${SERVER_IP}/proxied=${PROXIED}"
  fi
done

echo "==> Done. TLS is a separate step (infra/acme-issue-wildcard.sh for the wildcard;"
echo "    Caddy obtains per-host certs itself for names that resolve here)."
