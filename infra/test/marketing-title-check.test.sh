#!/usr/bin/env bash
#
# Tests for the post-deploy marketing host check (#2579, #2919).
#
# WHY THIS EXISTS
#   `infra/deploy-prod.sh` and `infra/server/topic-deploy.sh` each carry their
#   own copy of the brand-free title rule, in plain shell because the box need
#   not have Node: the landing's <title> must contain the `name` of the host's
#   own /manifest.webmanifest, and that name must be neither "Internship CRM"
#   nor the "coreCRM" fallback. scripts/marketing-content-probe.mjs states the
#   same rule for the external uptime job. Three copies of one rule drift unless
#   something holds them together, so this test
#     1. reads the helpers out of BOTH deploy scripts (never a copy kept here)
#        and requires them to be the same code,
#     2. runs one table of cases through them,
#     3. and, when Node is available, asks the uptime probe about the same
#        pairs and expects the same right/wrong answer.
#   It also pins the property the rewrite exists for: no verdict ever repeats
#   the manifest name it was given, because the deploy log is public.
#
# USAGE
#   bash infra/test/marketing-title-check.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_SH="$REPO_DIR/infra/deploy-prod.sh"
TOPIC_SH="$REPO_DIR/infra/server/topic-deploy.sh"
PROBE_MJS="$REPO_DIR/scripts/marketing-content-probe.mjs"

# Results go to a file, not a counter: most checks run in subshells (so the
# two scripts' helpers can never stand in for each other), and a subshell
# cannot move a variable of its parent.
RESULTS="$(mktemp)"
trap 'rm -f "$RESULTS"' EXIT
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; echo ok >> "$RESULTS"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; echo FAIL >> "$RESULTS"; }
eq() { # eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected '$2', got '$3'"; fi
}

HELPERS='marketing_page_title marketing_manifest_name marketing_title_verdict'

extract_fn() { # extract_fn <file> <name>
  sed -n "/^$2() {/,/^}/p" "$1"
}
load() { # load <file> — defines the three helpers from that file
  local fn
  for fn in $HELPERS; do eval "$(extract_fn "$1" "$fn")"; done
}

printf '\nBoth deploy scripts carry the helpers, as the same code\n'
for fn in $HELPERS; do
  a="$(extract_fn "$DEPLOY_SH" "$fn")"
  b="$(extract_fn "$TOPIC_SH" "$fn")"
  if [ -z "$a" ] || [ -z "$b" ]; then
    bad "$fn is defined in both scripts"
  elif [ "$a" = "$b" ]; then
    ok "$fn is identical in both scripts"
  else
    bad "$fn differs between deploy-prod.sh and topic-deploy.sh"
  fi
done

# ── The cases ────────────────────────────────────────────────────────────────
# <title>|<manifest name>|<expected verdict class>
#   ok — the landing is right; anything else names the reason it is not.
# The brand names are made up: a real one does not belong in this repository.
CASES='Acme Sales — Marketing CRM|Acme Sales|ok
Impressum · Acme Sales|Acme Sales|ok
ACME SALES — Marketing CRM|acme sales|ok
Internship CRM - Mentor-Mentee Management|Internship CRM|internship
Acme Sales · Internship CRM|Acme Sales|internship
Acme Sales — Marketing CRM|Internship CRM|internship
coreCRM — Marketing CRM|coreCRM|fallback
Acme Sales — Marketing CRM||noname
|Acme Sales|notitle
502 Bad Gateway|Acme Sales|mismatch
Other Brand — Marketing CRM|Acme Sales|mismatch'

classify() { # classify <verdict> — the reason class a verdict stands for
  case "$1" in
    '') echo ok ;;
    *INTERNSHIP*) echo internship ;;
    *coreCRM*) echo fallback ;;
    *'has no name'*) echo noname ;;
    *'no <title>'*) echo notitle ;;
    *'does not contain'*) echo mismatch ;;
    *) echo "unknown: $1" ;;
  esac
}

for script in "$DEPLOY_SH" "$TOPIC_SH"; do
  printf '\nVerdicts — %s\n' "${script#"$REPO_DIR"/}"
  (
    load "$script"
    while IFS='|' read -r title name expected; do
      verdict="$(marketing_title_verdict "$title" "$name")"
      eq "'${title:-<none>}' + '${name:-<none>}'" "$expected" "$(classify "$verdict")"
      if [ -n "$verdict" ] && [ -n "$name" ]; then
        case "$name" in 'coreCRM' | 'Internship CRM') ;; *)
          case "$verdict" in *"$name"*) bad "the verdict for '$title' repeats the manifest name" ;; esac ;;
        esac
      fi
    done <<<"$CASES"
  )
done

printf '\nParsing what the app serves\n'
(
  load "$DEPLOY_SH"
  eq 'the first <title> is the document title, entities decoded' 'Acme & Co — x' \
    "$(printf '<html><head><title>\n  Acme &amp; Co — x\n</title></head><body><svg><title>icon</title></svg></body></html>' | marketing_page_title)"
  eq 'a page without a title gives nothing' '' "$(printf '<html><body>x</body></html>' | marketing_page_title)"
  eq 'an empty response gives nothing' '' "$(printf '' | marketing_page_title)"
  eq 'an apostrophe React escaped reads back' "Acme's Sales" \
    "$(printf '<title>Acme&#x27;s Sales</title>' | marketing_page_title)"
  # The shape Next.js writes: compact JSON, `id` then `name`, shortcuts later.
  eq 'the manifest name is the top-level one' 'Acme Sales' \
    "$(printf '{"id":"/","name":"Acme Sales","short_name":"Acme","shortcuts":[{"name":"Messages"}]}' | marketing_manifest_name)"
  eq 'a pretty-printed manifest reads the same' 'Acme Sales' \
    "$(printf '{\n  "id": "/",\n  "name": "Acme Sales"\n}' | marketing_manifest_name)"
  eq 'an error page instead of a manifest gives nothing' '' \
    "$(printf '<html><title>502 Bad Gateway</title></html>' | marketing_manifest_name)"
)

printf '\nThe deploy check end to end, with curl stubbed\n'
(
  load "$DEPLOY_SH"
  for fn in marketing_probe_hosts marketing_content_check replica_port; do
    eval "$(extract_fn "$DEPLOY_SH" "$fn")"
  done
  REPLICAS=2; PORT=3200; REPLICA_PORT_STRIDE=10; ENV_FILE=/etc/example.env
  log()  { printf 'LOG %s\n' "$*"; }
  warn() { printf 'WARN %s\n' "$*"; }
  # Answers by the Host header and the path, like the app does. Anything else
  # is a host that does not answer (curl exits non-zero with no output).
  curl() {
    local host='' url=''
    while [ $# -gt 0 ]; do
      case "$1" in -H) host="${2#Host: }"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac
    done
    case "$host|${url##*/}" in
      'shop.acme.test|') printf '<html><head><title>Acme Sales — Marketing CRM</title></head></html>' ;;
      'shop.acme.test|manifest.webmanifest') printf '{"id":"/","name":"Acme Sales"}' ;;
      'lost.acme.test|') printf '<html><head><title>Internship CRM - Mentor-Mentee Management</title></head></html>' ;;
      'lost.acme.test|manifest.webmanifest') printf '{"id":"/","name":"Internship CRM"}' ;;
      *) return 7 ;;
    esac
  }
  scenario() { # scenario <MARKETING_PROBE_HOST> <MARKETING_HOSTS>
    MARKETING_PROBE_HOST="$1" MARKETING_HOSTS="$2"
    marketing_content_check
  }
  count() { printf '%s\n' "$1" | grep -c "$2" || true; }
  never_names_a_host() { # the deploy log is public
    case "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" in
      *acme*|*mentor-mentee*) bad "$1 — a host, title or name reached the log" ;;
      *) ok "$1 — no host, title or name in the log" ;;
    esac
  }

  out="$(scenario '' '')"
  eq 'no host anywhere: skipped, no warning' '1 0' "$(count "$out" 'skipped') $(count "$out" '^WARN')"

  out="$(scenario '' 'Shop.Acme.Test, lost.acme.test')"
  eq 'MARKETING_HOSTS: every host on every replica' '2 2' "$(count "$out" '^LOG Marketing host 1 on :32[01]0 OK') $(count "$out" '^WARN marketing host 2 on :32[01]0: it serves the INTERNSHIP landing')"
  never_names_a_host 'MARKETING_HOSTS' "$out"

  out="$(scenario 'lost.acme.test' 'shop.acme.test')"
  eq 'a caller-named host missing from MARKETING_HOSTS is called out' '1' "$(count "$out" '^WARN the marketing host named by MARKETING_PROBE_HOST is NOT in MARKETING_HOSTS')"
  eq 'and only that host is probed' '2 0' "$(count "$out" '^WARN marketing host 1 on') $(count "$out" 'marketing host 2')"
  never_names_a_host 'MARKETING_PROBE_HOST' "$out"

  out="$(scenario 'SHOP.acme.test' '')"
  # No built-in marketing host any more (#2926): an empty MARKETING_HOSTS serves
  # none, so a caller-named host is missing from it like from any other list.
  eq 'an empty MARKETING_HOSTS serves no marketing host: the caller-named host is called out' '1 1' "$(count "$out" '^WARN the marketing host named by MARKETING_PROBE_HOST is NOT in MARKETING_HOSTS') $(count "$out" '^WARN')"

  out="$(scenario 'gone.acme.test' 'gone.acme.test')"
  eq 'a host that does not answer warns' '2' "$(count "$out" '^WARN marketing host 1 on :32[01]0: no <title> in the landing')"
  never_names_a_host 'a host that does not answer' "$out"
)

printf '\nThe pre-swap guard refuses an environment that lost its marketing hosts (#2926)\n'
(
  eval "$(extract_fn "$DEPLOY_SH" marketing_hosts_guard)"
  ENV_FILE=/etc/internship-crm/test.env
  guard() { # guard <CONTAINER> <MARKETING_HOSTS> <MARKETING_PROBE_HOST> [NONE] [PROBE]
    CONTAINER="$1" MARKETING_HOSTS="$2" MARKETING_PROBE_HOST="$3" \
      MARKETING_HOSTS_NONE="${4:-0}" MARKETING_PROBE="${5:-1}" \
      marketing_hosts_guard 2>&1 && echo PASS || echo REFUSED
  }
  last() { printf '%s\n' "$1" | tail -1; }
  eq 'prod with an empty list is refused' 'REFUSED' "$(last "$(guard internship-crm '' '')")"
  eq 'preview with a whitespace-only list is refused' 'REFUSED' "$(last "$(guard internship-crm-preview '  ' '')")"
  eq 'prod with MARKETING_HOSTS_NONE=1 passes' 'PASS' "$(last "$(guard internship-crm '' '' 1)")"
  eq 'a topic env with an empty list passes' 'PASS' "$(last "$(guard internship-crm-pr12 '' '')")"
  eq 'prod with a list passes' 'PASS' "$(last "$(guard internship-crm 'shop.acme.test' '')")"
  eq 'a probe host in the list passes (case and spaces ignored)' 'PASS' "$(last "$(guard internship-crm 'a.acme.test, Shop.Acme.Test' 'SHOP.acme.test')")"
  eq 'a probe host missing from the list is refused' 'REFUSED' "$(last "$(guard internship-crm 'shop.acme.test' 'lost.acme.test')")"
  eq 'MARKETING_PROBE=0 skips the probe-host comparison' 'PASS' "$(last "$(guard internship-crm 'shop.acme.test' 'lost.acme.test' 0 0)")"
  out="$(guard internship-crm 'shop.acme.test' 'lost.acme.test')"
  case "$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')" in
    *acme*) bad 'the refusal names no host' ;;
    *) ok 'the refusal names no host' ;;
  esac
)

printf '\nThe uptime probe agrees on right and wrong\n'
if command -v node >/dev/null 2>&1 && [ -f "$PROBE_MJS" ]; then
  (
    load "$DEPLOY_SH"
    while IFS='|' read -r title name expected; do
      if [ -z "$(marketing_title_verdict "$title" "$name")" ]; then shell=right; else shell=wrong; fi
      # The module path goes in through the environment, not argv: the probe
      # runs its CLI when argv[1] is its own path.
      probe="$(PROBE="$PROBE_MJS" TITLE="$title" NAME="$name" node --input-type=module -e '
        const { judge } = await import(process.env.PROBE);
        const verdict = judge(process.env.TITLE || null, process.env.NAME || null);
        process.stdout.write(verdict ? "wrong" : "right");
      ')"
      eq "'${title:-<none>}' + '${name:-<none>}'" "$shell" "$probe"
    done <<<"$CASES"
  )
else
  printf '  (skipped: node or the probe is not available here)\n'
fi

passed="$(grep -c '^ok$' "$RESULTS" || true)"
failed="$(grep -c '^FAIL$' "$RESULTS" || true)"
printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
