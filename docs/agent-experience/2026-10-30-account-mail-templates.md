# 2026-10-30 — Account mails through the template editor (#3399)

- A mail that carries a one-time token can join the template editor without
  becoming a merge tag: keep its sender, build the URL there, and let the ONE
  renderer append the button + copy line after the template body. The test
  "a hostile body cannot remove the link" is then a count of the URL (2).
- `emailRender.ts` imports from `emailService.ts`; going the other way, use a
  dynamic `await import()` inside the sender to avoid a module cycle.
- Moving copy from a bare `getDictionary()` to `emailDictionary()` fails
  `check:mail-dictionary` until its PINNED number is lowered in the same diff.
- `pkill -f next-server` inside a backgrounded compound command kills the
  whole command (its own command line matches). Run it as its own call.
