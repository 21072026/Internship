#!/usr/bin/env bash
# Sender-authentication readiness check for the mail domain.
#
# Answers one question: is it safe to point SMTP_HOST at the Brevo relay yet?
# Switching before DKIM resolves is a strict regression — mail would leave
# carrying no signature aligned with our domain (see docs/EMAIL_DELIVERABILITY.md
# §2b, step 3), so this is meant to be run *before* editing prod.env.
#
# Usage:
#   ./infra/check-mail-dns.sh [domain] [sending-ip]
#   ./infra/check-mail-dns.sh crm.ersah.in 212.132.111.125
#
# Read-only: it performs DNS lookups and nothing else. Exit code is 0 when the
# domain is ready for the relay, 1 when DKIM is still missing.

set -uo pipefail

DOMAIN="${1:-crm.ersah.in}"
SEND_IP="${2:-212.132.111.125}"

if ! command -v dig >/dev/null 2>&1; then
  echo "dig not found — install dnsutils (Debian/Ubuntu: apt-get install -y dnsutils)" >&2
  exit 2
fi

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
grey()  { printf '\033[90m%s\033[0m\n' "$1"; }

echo "Mail authentication for ${DOMAIN}"
echo

# --- Brevo ownership code -----------------------------------------------------
brevo_code=$(dig +short TXT "$DOMAIN" | tr -d '"' | grep -i '^brevo-code:' || true)
if [ -n "$brevo_code" ]; then
  green "[ok]      Brevo code    ${brevo_code}"
else
  red   "[missing] Brevo code    no brevo-code: TXT on ${DOMAIN}"
fi

# --- DKIM ---------------------------------------------------------------------
# Brevo has shipped both TXT and CNAME forms and more than one selector, so try
# every shape rather than assuming one. Any hit counts.
dkim_found=""
for selector in brevo brevo1 brevo2 mail default; do
  host="${selector}._domainkey.${DOMAIN}"
  for rrtype in TXT CNAME; do
    answer=$(dig +short "$rrtype" "$host" | head -1)
    if [ -n "$answer" ]; then
      green "[ok]      DKIM          ${host} ${rrtype} → ${answer:0:60}..."
      dkim_found=1
    fi
  done
done
if [ -z "$dkim_found" ]; then
  red   "[MISSING] DKIM          nothing at {brevo,brevo1,brevo2,mail,default}._domainkey.${DOMAIN}"
  grey  "          → Brevo: Senders, Domains & Dedicated IPs → Domains → Authenticate."
  grey  "            Publish the record exactly as shown (copy its type: TXT or CNAME)."
fi

# --- SPF ----------------------------------------------------------------------
# Exactly one SPF record must exist. Brevo does NOT need an include: it owns the
# Return-Path, so SPF is evaluated against Brevo's domain and alignment comes
# from DKIM instead.
spf=$(dig +short TXT "$DOMAIN" | tr -d '"' | grep -i '^v=spf1' || true)
spf_count=$(printf '%s' "$spf" | grep -c . || true)
if [ "$spf_count" -eq 1 ]; then
  green "[ok]      SPF           ${spf}"
  if printf '%s' "$spf" | grep -qi 'spf.brevo.com'; then
    grey  "          note: include:spf.brevo.com is unnecessary for Brevo and costs one of SPF's 10 lookups."
  fi
elif [ "$spf_count" -eq 0 ]; then
  red   "[missing] SPF           no v=spf1 TXT on ${DOMAIN}"
else
  red   "[broken]  SPF           ${spf_count} SPF records — there must be exactly one; merge them"
fi

# --- DMARC --------------------------------------------------------------------
dmarc=$(dig +short TXT "_dmarc.${DOMAIN}" | tr -d '"' | grep -i '^v=DMARC1' || true)
if [ -n "$dmarc" ]; then
  green "[ok]      DMARC         ${dmarc}"
else
  red   "[missing] DMARC         no v=DMARC1 TXT on _dmarc.${DOMAIN}"
fi

# --- PTR ----------------------------------------------------------------------
# Only meaningful while the Plesk box still sends directly; a relay makes the
# sending IP Brevo's problem, not ours.
ptr=$(dig +short -x "$SEND_IP" | head -1)
if [ -n "$ptr" ]; then
  fwd=$(dig +short A "${ptr%.}" | head -1)
  if [ "$fwd" = "$SEND_IP" ]; then
    green "[ok]      PTR           ${SEND_IP} ↔ ${ptr%.} (forward-confirmed)"
  else
    red   "[weak]    PTR           ${SEND_IP} → ${ptr%.} but that resolves to '${fwd:-nothing}'"
  fi
else
  red   "[missing] PTR           no reverse DNS for ${SEND_IP}"
fi

echo
if [ -n "$dkim_found" ]; then
  green "Ready: DKIM resolves — you can point SMTP_HOST at smtp-relay.brevo.com."
  grey  "Then verify with Admin → Settings → Email health and a mail-tester.com address."
  exit 0
fi
red "Not ready: publish the DKIM record first. Switching the relay now would send"
red "mail with no signature aligned with ${DOMAIN} — worse than the current setup."
exit 1
