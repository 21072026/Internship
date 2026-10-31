
## Board paging (#1438)

- A container restart takes MariaDB down too. The symptom is `config.webServer` timing out with
  `Can't reach database server` in the job worker's log. Run `service mariadb start`, then
  `prisma db push`, then run the specs again.
- Old e2e specs drive sign-in through the form and wait 15–20 s for each navigation. A
  cold `next dev` misses that window on a different step each run. Before you suspect the
  change, re-run the spec alone and see whether it still fails at the same step.
