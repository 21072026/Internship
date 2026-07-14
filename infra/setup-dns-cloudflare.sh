#!/usr/bin/env bash
#
# CI-independent wildcard DNS setup (#636 / #583).
#
# Creates the wildcard `*.ersah.in` A record via the Cloudflare API so every
# topic subdomain (crm-topicN.ersah.in) resolves to the server. Idempotent:
# if a `*` A record already exists it does nothing. This is the same logic as
# the `dns` step of .github/workflows/infra-setup.yml, extracted so it can run
# from a laptop without GitHub Actions minutes.
#
# USAGE
#   export CF_Token="<scoped Cloudflare token: Zone:DNS:Edit + Zone:Read, ersah.in>"
#   SERVER_IP=<server public IP> ./infra/setup-dns-cloudflare.sh
#   # SERVER_IP optional if you run it ON the server (auto-detected).
#
# The cert (wildcard TLS) is issued by infra/acme-issue-wildcard.sh — run that
# ON the server. Both together complete the topic-preview foundations.
#
set -euo pipefail

DOMAIN="${DOMAIN:-ersah.in}"
: "${CF_Token:?export CF_Token with a scoped Cloudflare API token first}"

SERVER_IP="${SERVER_IP:-}"
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
fi
[ -n "$SERVER_IP" ] || { echo "ERROR: set SERVER_IP=<public ip>" >&2; exit 1; }
echo "==> Target server IP: $SERVER_IP"

api() { curl -sS -H "Authorization: Bearer $CF_Token" -H "Content-Type: application/json" "$@"; }

ZONE_ID="$(api "https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}" \
  | python3 -c "import sys,json;r=json.load(sys.stdin);print(r['result'][0]['id'] if r.get('result') else '')")"
[ -n "$ZONE_ID" ] || { echo "ERROR: zone ${DOMAIN} not found with this token (needs Zone:Read)" >&2; exit 1; }

EXISTING="$(api "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=%2A.${DOMAIN}" \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('result',[])))")"

if [ "$EXISTING" != "0" ]; then
  echo "==> Wildcard *.${DOMAIN} A record already exists — nothing to do."
  exit 0
fi

echo "==> Creating *.${DOMAIN} A → ${SERVER_IP} (proxied)"
api -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  --data "{\"type\":\"A\",\"name\":\"*\",\"content\":\"${SERVER_IP}\",\"proxied\":true,\"ttl\":1}" \
  | python3 -c "import sys,json;r=json.load(sys.stdin);assert r.get('success'),r;print('OK — wildcard record created.')"
