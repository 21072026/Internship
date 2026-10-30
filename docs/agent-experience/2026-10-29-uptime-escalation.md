# 2026-10-29 — uptime readiness + escalation, incident process (#1603/#1605)

- **Search the workflows before building a monitor**: `uptime.yml` (#2169) and
  `mysql-watchdog.yml` already did most of #1603 from GitHub-hosted runners; the issue text
  (2026-08) predates them and still names the retired Plesk hosts.
- **Mail from a GitHub-hosted runner usually does not leave** (SMTP connect ETIMEDOUT, #2322).
  A GitHub issue / @-mention is the paging channel that works; mail is best effort.
- `gh issue view --json … --jq` can print several `key=value` lines straight into
  `$GITHUB_OUTPUT`; test the jq expression locally against a sample JSON first.
