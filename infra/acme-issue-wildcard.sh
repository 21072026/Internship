#!/usr/bin/env bash
#
# Issue (and auto-renew) a wildcard Let's Encrypt certificate for the CRM's
# domain using acme.sh with Cloudflare's DNS-01 challenge.
#
# WHY DNS-01: wildcard certs (*.ersah.in) can ONLY be validated via the DNS-01
# challenge — HTTP-01 does not support wildcards. DNS-01 needs a TXT record at
# _acme-challenge.<domain>; acme.sh creates and removes it automatically through
# the Cloudflare API, so there is nothing to add by hand (that manual TXT step
# is exactly what failed with "No TXT record found").
#
# SECRETS: this script never contains a token. It reads CF_Token from the
# environment. acme.sh persists it (chmod 600) under ~/.acme.sh so subsequent
# auto-renewals don't need it re-supplied.
#
#   Create a scoped Cloudflare API token (My Profile → API Tokens → Custom):
#     - Zone → DNS  → Edit
#     - Zone → Zone → Read
#     - Zone resources: Include → Specific zone → ersah.in
#
# USAGE:
#   export CF_Token="<your scoped cloudflare token>"   # never commit this
#   ./infra/acme-issue-wildcard.sh
#
# Env overrides (all optional):
#   DOMAIN         apex domain                (default: ersah.in)
#   CERT_DIR       where the cert is installed (default: /etc/nginx/ssl)
#   RELOAD_CMD     reload after install/renew  (default: systemctl reload nginx)
#   ACME_SERVER    CA to use                   (default: letsencrypt)
#
set -euo pipefail

DOMAIN="${DOMAIN:-ersah.in}"
CERT_DIR="${CERT_DIR:-/etc/nginx/ssl}"
RELOAD_CMD="${RELOAD_CMD:-systemctl reload nginx}"
ACME_SERVER="${ACME_SERVER:-letsencrypt}"

if [ -z "${CF_Token:-}" ]; then
  echo "ERROR: CF_Token is not set. Export your scoped Cloudflare API token first:" >&2
  echo '  export CF_Token="..."' >&2
  exit 1
fi

# Install acme.sh once if it isn't already present.
if ! command -v acme.sh >/dev/null 2>&1 && [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
  echo "==> Installing acme.sh"
  curl -fsSL https://get.acme.sh | sh -s email="admin@${DOMAIN}"
fi
ACME="$(command -v acme.sh || echo "$HOME/.acme.sh/acme.sh")"

mkdir -p "$CERT_DIR"

echo "==> Issuing wildcard cert for ${DOMAIN} and *.${DOMAIN} via Cloudflare DNS-01"
# --dns dns_cf uses the Cloudflare provider; acme.sh reads $CF_Token and
# creates/removes the _acme-challenge TXT automatically.
"$ACME" --issue \
  --dns dns_cf \
  -d "${DOMAIN}" \
  -d "*.${DOMAIN}" \
  --server "${ACME_SERVER}" \
  --keylength ec-256

echo "==> Installing cert to ${CERT_DIR} (reload: ${RELOAD_CMD})"
"$ACME" --install-cert -d "${DOMAIN}" --ecc \
  --key-file       "${CERT_DIR}/${DOMAIN}.key" \
  --fullchain-file "${CERT_DIR}/${DOMAIN}.cer" \
  --reloadcmd      "${RELOAD_CMD}"

echo "==> Done. acme.sh installed a cron entry; renewals (~every 60 days) are automatic."
echo "    Cert:  ${CERT_DIR}/${DOMAIN}.cer"
echo "    Key:   ${CERT_DIR}/${DOMAIN}.key"
