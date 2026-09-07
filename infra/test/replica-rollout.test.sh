#!/usr/bin/env bash
#
# Tests for the replica arithmetic and the routing config the rolling deploy
# generates (#1701).
#
# WHY THIS EXISTS
#   `infra/deploy-prod.sh` only ever runs on the server, mid-deploy, against
#   docker — exactly like the backup validation and the schema guard next to
#   this file, and for the same reason both of those got a test after they
#   broke production. Two things in the new replica code are worth pinning:
#
#     1. Replica 1 must keep the historical name and port. Everything else on
#        the box addresses it that way — the env-file capture, `--rollback`,
#        the drift gate's /api/health read — so a change here is an outage that
#        looks like a rename.
#     2. A single replica must produce the same one-upstream site file
#        bootstrap.sh writes, with no load-balancer stanza. That is the whole
#        "reversible, and no behaviour change at REPLICAS=1" claim, and it is
#        the sort of claim that is true when it is written and false a month
#        later.
#
# USAGE
#   bash infra/test/replica-rollout.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SH="$SCRIPT_DIR/../deploy-prod.sh"
ROUTE_SH="$SCRIPT_DIR/../server/replica-route.sh"

pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
eq() { # eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected '$2', got '$3'"; fi
}

# ── The replica helpers, lifted out of the deploy script itself ─────────────
# Read from the file rather than copied here: a test that carries its own copy
# of the arithmetic passes against a stale duplicate, which is worse than no
# test. `sed` pulls the two functions out verbatim and eval defines them.
extract_fn() { # extract_fn <name>
  sed -n "/^$1() {/,/^}/p" "$DEPLOY_SH"
}
CONTAINER=internship-crm
PORT=3200
REPLICA_PORT_STRIDE=10
eval "$(extract_fn replica_container)"
eval "$(extract_fn replica_port)"
eval "$(extract_fn replica_net_args)"
eval "$(extract_fn replica_extra_env)"
if ! declare -F replica_container >/dev/null || ! declare -F replica_port >/dev/null; then
  printf '\033[31mXX\033[0m could not read the replica helpers out of %s\n' "$DEPLOY_SH" >&2
  exit 1
fi

printf '\nReplica identity\n'
eq 'replica 1 keeps the historical container name' 'internship-crm' "$(replica_container 1)"
eq 'replica 1 keeps the historical port'           '3200'           "$(replica_port 1)"
eq 'replica 2 is suffixed'                         'internship-crm-2' "$(replica_container 2)"
eq 'replica 2 sits one stride up'                  '3210'           "$(replica_port 2)"
eq 'replica 3 too, should anyone want one'         '3220'           "$(replica_port 3)"

# Preview shares the box with prod, so the two pools must not collide.
PORT=3201
eq 'preview replica 1'  '3201' "$(replica_port 1)"
eq 'preview replica 2'  '3211' "$(replica_port 2)"
# The canary lives at PORT+100 (3300/3301) and topic environments at 3400-3499:
# a stride of 10 keeps two replicas clear of both.
if [ "$(replica_port 2)" -lt 3300 ]; then ok 'the replica pool stays clear of the canary port'; else bad 'replica 2 collides with the canary port'; fi
PORT=3200

printf '\nDocker flags\n'
# Host networking (prod): the app is told which port to listen on.
NETWORK=host
mapfile -d '' -t args < <(replica_net_args 3200)
eq 'host networking, replica 1' '--network=host -e PORT=3200' "${args[*]}"
mapfile -d '' -t args < <(replica_net_args 3210)
eq 'host networking, replica 2' '--network=host -e PORT=3210' "${args[*]}"
# Bridge networking (preview): the port is published instead.
NETWORK=bridge
mapfile -d '' -t args < <(replica_net_args 3201)
eq 'bridge networking publishes the port' '--add-host=host.docker.internal:host-gateway -p 3201:3000' "${args[*]}"
NETWORK=host

# The interim scheduler guard: replica 1 keeps the cron, every other replica
# runs with it switched off, so no reminder is ever sent twice while #1676 is
# still to land. A regression here is silent and doubles real e-mail.
mapfile -d '' -t extra < <(replica_extra_env 1)
eq 'replica 1 keeps the scheduler' '' "${extra[*]:-}"
mapfile -d '' -t extra < <(replica_extra_env 2)
eq 'replica 2 runs with the cron switched off' '-e CRON_ENABLED=0' "${extra[*]:-}"
mapfile -d '' -t extra < <(replica_extra_env 3)
eq 'and so does any further replica' '-e CRON_ENABLED=0' "${extra[*]:-}"

printf '\nGenerated routing\n'
SITES="$(mktemp -d)"
trap 'rm -rf "$SITES"' EXIT
route() { ROUTER=caddy CADDY_SITES_DIR="$SITES" CADDY_RELOAD_CMD=true bash "$ROUTE_SH" "$@" >/dev/null 2>&1; }

if route --host interncrm.com --ports "3200"; then
  file="$SITES/interncrm.com.caddy"
  # One replica: the same single `reverse_proxy` line bootstrap.sh writes, and
  # NOTHING else. No lb_policy, no health checks — a one-container environment
  # must not inherit any of the two-replica machinery.
  eq 'one replica is one plain upstream' 'reverse_proxy 127.0.0.1:3200' "$(sed -n 's/^ *//; /^reverse_proxy/p' "$file")"
  if grep -q 'lb_policy' "$file"; then bad 'one replica must not get a load-balancer stanza'; else ok 'one replica gets no load-balancer stanza'; fi
else
  bad 'routing a single replica failed'
fi

if route --host interncrm.com --ports "3200 3210"; then
  file="$SITES/interncrm.com.caddy"
  if grep -q 'reverse_proxy 127.0.0.1:3200 127.0.0.1:3210 {' "$file"; then ok 'two replicas are one upstream pool'; else bad 'two replicas did not produce a two-upstream pool'; fi
  for directive in lb_policy lb_try_duration health_uri fail_duration; do
    if grep -q "$directive" "$file"; then ok "pool declares $directive"; else bad "pool is missing $directive"; fi
  done
  # The acceptance criterion from #1701: no sticky sessions, and the config
  # itself has to say why, so the next person does not add ip_hash "to be safe".
  if grep -q 'ip_hash' "$file"; then
    if grep -q 'No ip_hash' "$file"; then ok 'ip_hash appears only in the comment explaining its absence'; else bad 'the generated config enables ip_hash'; fi
  else
    bad 'the generated config does not mention why there are no sticky sessions'
  fi
  if grep -q 'signed JWT' "$file"; then ok 'the comment gives the reason (stateless sessions)'; else bad 'the no-sticky-sessions comment lost its reason'; fi
else
  bad 'routing two replicas failed'
fi

# Draining is just a shorter port list, and going back to one replica restores
# the single-upstream file — the reversibility claim, executed.
if route --host interncrm.com --ports "3210"; then
  eq 'a drained pool routes only to the survivor' 'reverse_proxy 127.0.0.1:3210' "$(sed -n 's/^ *//; /^reverse_proxy/p' "$SITES/interncrm.com.caddy")"
else
  bad 'draining to a single replica failed'
fi
if route --host interncrm.com --ports "3200"; then
  if grep -q 'lb_policy' "$SITES/interncrm.com.caddy"; then
    bad 'shrinking back to one replica left the load-balancer stanza behind'
  else
    ok 'shrinking back to one replica restores the single-upstream file'
  fi
else
  bad 'shrinking back to one replica failed'
fi

# A rejected config must not take the site down with it: the previous file has
# to survive a validation failure (prod would otherwise be un-routed).
ROUTER=caddy CADDY_SITES_DIR="$SITES" CADDY_RELOAD_CMD=false bash "$ROUTE_SH" --host interncrm.com --ports "3200 3210" >/dev/null 2>&1 || true
if [ -s "$SITES/interncrm.com.caddy" ] && grep -q 'reverse_proxy' "$SITES/interncrm.com.caddy"; then
  ok 'a rejected config leaves the previous site file in place'
else
  bad 'a rejected config removed the site file — that is an outage, not a rollback'
fi

# A bad port is a configuration mistake and must be refused before anything is
# written, not passed through into the proxy config.
if ROUTER=caddy CADDY_SITES_DIR="$SITES" CADDY_RELOAD_CMD=true bash "$ROUTE_SH" --host interncrm.com --ports "3200 not-a-port" >/dev/null 2>&1; then
  bad 'a non-numeric port was accepted'
else
  ok 'a non-numeric port is refused'
fi

printf '\n%d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
